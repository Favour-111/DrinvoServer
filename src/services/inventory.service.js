import mongoose from 'mongoose';
import {
  Inventory,
  InventoryMovement,
  Product,
  ProductVariant,
  StockAdjustment,
} from '../models/index.js';
import { ADJUSTMENT_TYPES } from '../config/constants.js';
import { ApiError } from '../utils/ApiError.js';
import { createDoc, runAtomic } from '../utils/atomic.js';
import { describeStock, toBase } from '../utils/units.js';
import { formatNumber, nextSequence } from '../utils/sequence.js';
import { escapeRegex, pageParams } from '../utils/serialize.js';
import { logAudit } from './audit.service.js';

const round2 = (n) => Math.round(n * 100) / 100;

export function stockStatus(quantity, threshold) {
  if (quantity <= 0) return 'out';
  if (quantity <= threshold) return 'low';
  return 'in';
}

/**
 * The single entry point for changing stock. Every call writes an
 * InventoryMovement, so stock is never changed silently.
 *
 * - delta < 0 removes stock and fails if it would go below zero.
 * - restockTotal (money) blends new stock into the weighted average cost.
 * - otherwise stock is added without changing the average cost.
 *
 * Returns { inventory, movement, unitCost } where unitCost is the average
 * cost per bottle before this change (the cost basis for a sale).
 */
export async function applyMovement(ctx, tx, { variant, delta, type, restockTotal = null, ref = null, reason = '' }) {
  if (!delta) throw new Error('applyMovement requires a non-zero delta');
  const filter = { shopId: ctx.shopId, productVariantId: variant._id };
  const opts = { new: true, session: tx.session };
  let inventory;
  let unitCost;

  if (delta < 0) {
    inventory = await Inventory.findOneAndUpdate({ ...filter, quantity: { $gte: -delta } }, { $inc: { quantity: delta } }, opts);
    if (!inventory) {
      const current = await Inventory.findOne(filter).session(tx.session).lean();
      const available = current?.quantity || 0;
      throw ApiError.conflict(`Not enough stock available for ${variant.name}. Only ${describeStock(variant, available)} left.`, {
        variantId: String(variant._id),
        available,
        requested: -delta,
      });
    }
    tx.undo(() => Inventory.updateOne({ _id: inventory._id }, { $inc: { quantity: -delta } }));
    unitCost = inventory.avgCost || variant.costPrice;
  } else if (restockTotal !== null) {
    const before = await Inventory.findOne(filter).session(tx.session).lean();
    const q = { $ifNull: ['$quantity', 0] };
    const a = { $ifNull: ['$avgCost', 0] };
    const newQty = { $add: [q, delta] };
    inventory = await Inventory.findOneAndUpdate(
      filter,
      [
        {
          $set: {
            businessId: { $ifNull: ['$businessId', ctx.businessId] },
            // Weighted average: (old qty x old avg + cost of new stock) / new qty
            avgCost: { $cond: [{ $gt: [newQty, 0] }, { $divide: [{ $add: [{ $multiply: [q, a] }, restockTotal] }, newQty] }, a] },
            quantity: newQty,
            lowStockThreshold: { $ifNull: ['$lowStockThreshold', null] },
            createdAt: { $ifNull: ['$createdAt', '$$NOW'] },
            updatedAt: '$$NOW',
          },
        },
      ],
      { ...opts, upsert: true, timestamps: false }
    );
    tx.undo(() =>
      before
        ? Inventory.updateOne({ _id: inventory._id }, { $inc: { quantity: -delta }, $set: { avgCost: before.avgCost } })
        : Inventory.deleteOne({ _id: inventory._id })
    );
    unitCost = round2(restockTotal / delta);
  } else {
    inventory = await Inventory.findOneAndUpdate(
      filter,
      { $inc: { quantity: delta }, $setOnInsert: { businessId: ctx.businessId, avgCost: variant.costPrice } },
      { ...opts, upsert: true, setDefaultsOnInsert: true }
    );
    tx.undo(() => Inventory.updateOne({ _id: inventory._id }, { $inc: { quantity: -delta } }));
    unitCost = inventory.avgCost || variant.costPrice;
  }

  const movement = await createDoc(
    InventoryMovement,
    {
      businessId: ctx.businessId,
      shopId: ctx.shopId,
      productVariantId: variant._id,
      type,
      quantity: delta,
      balanceAfter: inventory.quantity,
      unitCost: round2(unitCost),
      referenceType: ref?.type ?? null,
      referenceId: ref?.id ?? null,
      referenceNumber: ref?.number ?? '',
      performedBy: ctx.userId,
      reason,
    },
    tx
  );
  ctx.touchedVariantIds?.add(String(variant._id));
  return { inventory, movement, unitCost: round2(unitCost) };
}

/** Loads a variant (with its product) that belongs to the caller's business. */
export async function loadVariant(ctx, variantId, { session = null, requireActive = true } = {}) {
  const variant = await ProductVariant.findOne({ _id: variantId, businessId: ctx.businessId }).session(session).lean();
  if (!variant) throw ApiError.notFound('Product not found.');
  const product = await Product.findById(variant.productId).session(session).lean();
  if (requireActive && (variant.status !== 'ACTIVE' || product?.status !== 'ACTIVE')) {
    throw ApiError.badRequest(`${variant.name} is archived.`);
  }
  variant.product = product;
  return variant;
}

/**
 * Flat list of every variant with its stock at the current shop.
 * Missing inventory rows count as zero stock.
 */
export async function stockRows(ctx, { includeArchived = false, q, category, status, productIds, variantIds } = {}) {
  const productFilter = { businessId: ctx.businessId };
  if (!includeArchived) productFilter.status = 'ACTIVE';
  if (category) productFilter.category = category;
  if (productIds) productFilter._id = { $in: productIds };
  const variantFilter = { businessId: ctx.businessId };
  if (!includeArchived) variantFilter.status = 'ACTIVE';
  if (productIds) variantFilter.productId = { $in: productIds };
  if (variantIds) variantFilter._id = { $in: variantIds };
  // Fetched together (one round trip); variants are matched to products below
  const [products, variants, inventories] = await Promise.all([
    Product.find(productFilter).lean(),
    ProductVariant.find(variantFilter).lean(),
    Inventory.find({ shopId: ctx.shopId }).lean(),
  ]);
  const byProduct = new Map(products.map((p) => [String(p._id), p]));
  const byVariant = new Map(inventories.map((i) => [String(i.productVariantId), i]));

  const needle = q ? new RegExp(escapeRegex(q), 'i') : null;
  const rows = [];
  for (const v of variants) {
    const p = byProduct.get(String(v.productId));
    if (!p) continue;
    if (needle && !needle.test(v.name) && !needle.test(p.brand) && !needle.test(p.category)) continue;
    const inv = byVariant.get(String(v._id));
    const quantity = inv?.quantity ?? 0;
    const threshold = inv?.lowStockThreshold ?? v.lowStockThreshold ?? 0;
    const avgCost = inv?.avgCost || v.costPrice;
    const st = p.status === 'ARCHIVED' || v.status === 'ARCHIVED' ? 'archived' : stockStatus(quantity, threshold);
    if (status && st !== status) continue;
    rows.push({
      variantId: String(v._id),
      productId: String(p._id),
      name: v.name,
      productName: p.name,
      brand: p.brand,
      category: p.category,
      color: p.color,
      shape: p.shape,
      image: v.image || p.image,
      size: v.size,
      unit: v.unit,
      costPrice: v.costPrice,
      avgCost: round2(avgCost),
      sellingPrice: v.sellingPrice,
      unitConversions: { bottle: 1, pack: v.unitConversions?.pack || 0, carton: v.unitConversions?.carton || 0, crate: v.unitConversions?.crate || 0 },
      unitPrices: { pack: v.unitPrices?.pack || 0, carton: v.unitPrices?.carton || 0, crate: v.unitPrices?.crate || 0 },
      quantity,
      lowStockThreshold: threshold,
      inventoryValue: round2(quantity * avgCost),
      status: st,
      productStatus: p.status,
    });
  }
  rows.sort((a, b) => a.productName.localeCompare(b.productName) || a.size.localeCompare(b.size, undefined, { numeric: true }));
  return rows;
}

export function summarize(rows) {
  const live = rows.filter((r) => r.status !== 'archived');
  return {
    variantCount: live.length,
    productCount: new Set(live.map((r) => r.productId)).size,
    totalBottles: live.reduce((s, r) => s + r.quantity, 0),
    lowStock: live.filter((r) => r.status === 'low').length,
    outOfStock: live.filter((r) => r.status === 'out').length,
    inventoryValue: round2(live.reduce((s, r) => s + r.inventoryValue, 0)),
  };
}

export async function listInventory(ctx, query) {
  const rows = await stockRows(ctx, { q: query.q, category: query.category, status: query.status });
  const all = query.q || query.status || query.category ? await stockRows(ctx) : rows;
  return { items: rows, summary: summarize(all) };
}

export async function getInventoryDetail(ctx, variantId, { withHistory }) {
  const variant = await loadVariant(ctx, variantId, { requireActive: false });
  const [row] = await stockRows(ctx, { includeArchived: true, productIds: [variant.productId] }).then((rs) =>
    rs.filter((r) => r.variantId === String(variant._id))
  );
  const result = { item: row };
  if (withHistory) {
    const movements = await listMovements(ctx, { variantId, limit: 100 });
    result.movements = movements.items;
  }
  return result;
}

export async function listMovements(ctx, query) {
  const { page, limit, skip } = pageParams(query, { defaultLimit: 50 });
  const filter = { shopId: ctx.shopId };
  if (query.variantId) filter.productVariantId = new mongoose.Types.ObjectId(query.variantId);
  if (query.type) filter.type = { $in: String(query.type).split(',') };
  const [items, total] = await Promise.all([
    InventoryMovement.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('performedBy', 'name')
      .populate('productVariantId', 'name size')
      .lean(),
    InventoryMovement.countDocuments(filter),
  ]);
  return {
    items: items.map((m) => ({
      id: String(m._id),
      type: m.type,
      quantity: m.quantity,
      balanceAfter: m.balanceAfter,
      unitCost: m.unitCost,
      reason: m.reason,
      referenceType: m.referenceType,
      referenceId: m.referenceId ? String(m.referenceId) : null,
      referenceNumber: m.referenceNumber,
      createdAt: m.createdAt,
      performedBy: m.performedBy ? { id: String(m.performedBy._id), name: m.performedBy.name } : null,
      variant: m.productVariantId ? { id: String(m.productVariantId._id), name: m.productVariantId.name, size: m.productVariantId.size } : null,
    })),
    total,
    page,
    pages: Math.ceil(total / limit) || 1,
  };
}

/** Records damaged, lost, expired or corrected stock. Always creates a movement. */
export async function createAdjustment(ctx, input) {
  const def = ADJUSTMENT_TYPES[input.type];
  const variant = await loadVariant(ctx, input.variantId, { requireActive: false });
  const sign = def.direction === -1 ? -1 : input.direction === 'add' ? 1 : -1;
  const { baseQuantity } = toBase(variant, input.unit, input.quantity);
  const delta = sign * baseQuantity;

  return runAtomic(async (tx) => {
    const number = formatNumber('ADJ-', await nextSequence(`adjustment:${ctx.shopId}`, tx), 5);
    const adjustmentId = new mongoose.Types.ObjectId();
    const { inventory, unitCost } = await applyMovement(ctx, tx, {
      variant,
      delta,
      type: def.movement,
      ref: { type: 'StockAdjustment', id: adjustmentId, number },
      reason: `${def.label}: ${input.notes}`,
    });
    const adjustment = await createDoc(
      StockAdjustment,
      {
        _id: adjustmentId,
        businessId: ctx.businessId,
        shopId: ctx.shopId,
        adjustmentNumber: number,
        productVariantId: variant._id,
        type: input.type,
        quantity: delta,
        unit: input.unit,
        unitQuantity: input.quantity,
        balanceBefore: inventory.quantity - delta,
        balanceAfter: inventory.quantity,
        unitCost,
        notes: input.notes,
        performedBy: ctx.userId,
      },
      tx
    );
    await logAudit(
      ctx,
      {
        category: 'inventory',
        action: 'inventory.adjusted',
        summary: 'recorded adjustment',
        target: variant.name,
        detail: `${delta > 0 ? '+' : '−'}${describeStock(variant, Math.abs(delta))} · ${def.label}`,
        entityType: 'StockAdjustment',
        entityId: adjustment._id,
      },
      tx
    );
    return { adjustment: adjustment.toJSON(), balanceAfter: inventory.quantity };
  });
}

export async function listAdjustments(ctx, query) {
  const { page, limit, skip } = pageParams(query);
  const filter = { shopId: ctx.shopId };
  const [items, total] = await Promise.all([
    StockAdjustment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('performedBy', 'name').populate('productVariantId', 'name').lean(),
    StockAdjustment.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) || 1 };
}
