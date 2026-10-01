import mongoose from 'mongoose';
import { Shop, StockTransfer } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { createDoc, runAtomic } from '../utils/atomic.js';
import { toBase } from '../utils/units.js';
import { formatNumber, nextSequence } from '../utils/sequence.js';
import { pageParams } from '../utils/serialize.js';
import { resolveRange } from '../utils/dates.js';
import { applyMovement, loadVariant, stockRows } from './inventory.service.js';
import { broadcastStock } from '../realtime/stockHub.js';
import { logAudit } from './audit.service.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function assertShop(ctx, shopId) {
  const shop = await Shop.findOne({ _id: shopId, businessId: ctx.businessId, isActive: true }).lean();
  if (!shop) throw ApiError.badRequest('Choose a valid shop.');
  return shop;
}

/**
 * Moves stock from one shop to another in one atomic write: subtracts the source shop's
 * inventory, adds to the destination shop's (creating it if it doesn't exist yet), and records
 * a TRANSFER_OUT / TRANSFER_IN movement on each side — never a generic adjustment, so reporting
 * can tell transfers apart from damage, loss, etc. Transfers never touch sales, revenue or profit.
 */
export async function createStockTransfer(ctx, { fromShopId, toShopId, items, notes }) {
  if (String(fromShopId) === String(toShopId)) throw ApiError.badRequest('Source and destination shops must be different.');
  const [fromShop, toShop] = await Promise.all([assertShop(ctx, fromShopId), assertShop(ctx, toShopId)]);

  const lines = [];
  for (const item of items) {
    const variant = await loadVariant(ctx, item.variantId);
    const { conversion, baseQuantity } = toBase(variant, item.unit, item.quantity);
    lines.push({ variant, item, conversion, baseQuantity });
  }

  const result = await runAtomic(async (tx) => {
    const number = formatNumber('TRF-', await nextSequence(`transfer:${ctx.businessId}`, tx), 6);
    const transferId = new mongoose.Types.ObjectId();
    // Movements must land on the source/destination shops, not whichever shop the admin currently
    // has active — fresh touchedVariantIds per clone so the generic per-request stock broadcast
    // (scoped to ctx.shopId) doesn't fire; this function broadcasts to both shops itself below.
    const fromCtx = { ...ctx, shopId: fromShop._id, touchedVariantIds: new Set() };
    const toCtx = { ...ctx, shopId: toShop._id, touchedVariantIds: new Set() };

    for (const l of lines) {
      const { unitCost } = await applyMovement(fromCtx, tx, {
        variant: l.variant,
        delta: -l.baseQuantity,
        type: 'TRANSFER_OUT',
        ref: { type: 'StockTransfer', id: transferId, number },
        reason: `Transfer to ${toShop.name}`,
      });
      // The destination's weighted-average cost blends in at the source's cost basis, exactly
      // like a restock would — the stock's cost doesn't change just because it moved shops.
      await applyMovement(toCtx, tx, {
        variant: l.variant,
        delta: l.baseQuantity,
        type: 'TRANSFER_IN',
        restockTotal: unitCost * l.baseQuantity,
        ref: { type: 'StockTransfer', id: transferId, number },
        reason: `Transfer from ${fromShop.name}`,
      });
    }

    const transfer = await createDoc(
      StockTransfer,
      {
        _id: transferId,
        businessId: ctx.businessId,
        fromShopId: fromShop._id,
        toShopId: toShop._id,
        transferNumber: number,
        items: lines.map((l) => ({
          productVariantId: l.variant._id,
          name: l.variant.name,
          unit: l.item.unit,
          quantity: l.item.quantity,
          conversion: l.conversion,
          baseQuantity: l.baseQuantity,
        })),
        status: 'COMPLETED',
        notes: notes || '',
        createdBy: ctx.userId,
        completedAt: new Date(),
      },
      tx
    );

    const totalBottles = lines.reduce((s, l) => s + l.baseQuantity, 0);
    await logAudit(
      ctx,
      {
        category: 'inventory',
        action: 'inventory.transferred',
        summary: lines.length === 1 ? 'transferred stock' : `transferred ${lines.length} products`,
        target: lines.length === 1 ? lines[0].variant.name : number,
        detail: `${plural(totalBottles, 'bottle')} · ${fromShop.name} → ${toShop.name}`,
        entityType: 'StockTransfer',
        entityId: transferId,
      },
      tx
    );

    return { id: String(transfer._id), transferNumber: number };
  });

  // Push live stock updates to both shops — not just whichever shop the admin currently has active.
  const variantIds = [...new Set(lines.map((l) => String(l.variant._id)))];
  const [fromRows, toRows] = await Promise.all([
    stockRows({ ...ctx, shopId: fromShop._id }, { includeArchived: true, variantIds }),
    stockRows({ ...ctx, shopId: toShop._id }, { includeArchived: true, variantIds }),
  ]);
  broadcastStock(fromShop._id, fromRows);
  broadcastStock(toShop._id, toRows);

  return result;
}

function transferView(t) {
  return {
    id: String(t._id),
    transferNumber: t.transferNumber,
    fromShop: t.fromShopId ? { id: String(t.fromShopId._id ?? t.fromShopId), name: t.fromShopId.name } : null,
    toShop: t.toShopId ? { id: String(t.toShopId._id ?? t.toShopId), name: t.toShopId.name } : null,
    items: t.items.map((i) => ({
      variantId: String(i.productVariantId),
      name: i.name,
      unit: i.unit,
      quantity: i.quantity,
      conversion: i.conversion,
      baseQuantity: i.baseQuantity,
    })),
    itemCount: t.items.length,
    totalBaseQuantity: t.items.reduce((s, i) => s + i.baseQuantity, 0),
    status: t.status,
    notes: t.notes,
    createdBy: t.createdBy ? { id: String(t.createdBy._id ?? t.createdBy), name: t.createdBy.name } : null,
    completedAt: t.completedAt,
    createdAt: t.createdAt,
  };
}

export async function listTransfers(ctx, query) {
  const { page, limit, skip } = pageParams(query, { defaultLimit: 50 });
  const filter = { businessId: ctx.businessId };
  if (query.shopId) filter.$or = [{ fromShopId: query.shopId }, { toShopId: query.shopId }];
  if (query.status) filter.status = query.status;
  if (query.variantId) filter['items.productVariantId'] = new mongoose.Types.ObjectId(query.variantId);
  if (query.range && query.range !== 'all') {
    const r = resolveRange(query, ctx.business.timezone);
    filter.createdAt = { $gte: r.start, $lt: r.end };
  }
  const [items, total] = await Promise.all([
    StockTransfer.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('fromShopId', 'name').populate('toShopId', 'name').populate('createdBy', 'name').lean(),
    StockTransfer.countDocuments(filter),
  ]);
  return { items: items.map(transferView), total, page, pages: Math.ceil(total / limit) || 1 };
}

export async function getTransfer(ctx, id) {
  const t = await StockTransfer.findOne({ _id: id, businessId: ctx.businessId })
    .populate('fromShopId', 'name')
    .populate('toShopId', 'name')
    .populate('createdBy', 'name')
    .lean();
  if (!t) throw ApiError.notFound('Transfer not found.');
  return transferView(t);
}
