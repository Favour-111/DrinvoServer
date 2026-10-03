import { OnDemandPurchase, Product, ProductVariant, Shop, Inventory } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { createDoc, runAtomic } from '../utils/atomic.js';
import { conversionFor, toBase } from '../utils/units.js';
import { formatNumber, nextSequence } from '../utils/sequence.js';
import { pageParams } from '../utils/serialize.js';
import { applyMovement, loadVariant, stockRows } from './inventory.service.js';
import { logAudit } from './audit.service.js';

const CATEGORY_COLORS = {
  'Soft Drink': '#0EA271',
  'Malt Drink': '#D97706',
  Water: '#0EA5E9',
  Juice: '#F97316',
  'Energy Drink': '#6366F1',
  Beer: '#65A30D',
};
const round2 = (n) => Math.round(n * 100) / 100;

function personView(p) {
  if (!p) return null;
  if (p.name) return { id: String(p._id), name: p.name, color: p.color || null };
  return { id: String(p), name: null };
}

function odpView(o) {
  return {
    id: String(o._id),
    odpNumber: o.odpNumber,
    shopId: String(o.shopId),
    variantId: String(o.productVariantId),
    name: o.name,
    unit: o.unit,
    requestedQuantity: o.requestedQuantity,
    quantity: o.quantity,
    baseQuantity: o.baseQuantity,
    remainingBaseQuantity: o.remainingBaseQuantity,
    soldBaseQuantity: o.baseQuantity - o.remainingBaseQuantity,
    purchasedFrom: o.purchasedFrom,
    purchasedFromPhone: o.purchasedFromPhone || '',
    unitCost: o.unitCost,
    totalCost: o.totalCost,
    sellingPricePerUnit: o.sellingPricePerUnit,
    customerName: o.customerName || '',
    notes: o.notes,
    status: o.status,
    createdBy: personView(o.createdBy),
    createdAt: o.createdAt,
    purchasedAt: o.purchasedAt,
    cancelledAt: o.cancelledAt,
    cancelReason: o.cancelReason,
    saleLinks: (o.saleLinks || []).map((s) => ({ saleId: String(s.saleId), receiptNumber: s.receiptNumber, baseQuantity: s.baseQuantity, date: s.date })),
  };
}

/** Creates the catalog entry for a product this shop has never stocked — a minimal variant, with
 * opening stock always 0 (stock only lands once this purchase itself is marked PURCHASED). */
async function createMinimalVariant(ctx, tx, input) {
  const product = await createDoc(
    Product,
    {
      businessId: ctx.businessId,
      name: input.name,
      brand: input.brand || '',
      category: input.category,
      color: CATEGORY_COLORS[input.category] || '#059669',
      shape: 'bottle',
    },
    tx
  );
  const variant = await createDoc(
    ProductVariant,
    {
      businessId: ctx.businessId,
      productId: product._id,
      name: `${input.name} ${input.size}`,
      size: input.size,
      costPrice: 0,
      sellingPrice: input.sellingPrice,
    },
    tx
  );
  const shops = await Shop.find({ businessId: ctx.businessId }, '_id').session(tx.session).lean();
  for (const shop of shops) {
    await createDoc(Inventory, { businessId: ctx.businessId, shopId: shop._id, productVariantId: variant._id, quantity: 0, avgCost: 0 }, tx);
  }
  variant.product = product;
  return variant;
}

/**
 * Step 1: record that a customer wants something this shop doesn't have, before anything has
 * been bought. No stock or cost is touched yet — that happens at `markPurchased`.
 */
export async function createOnDemandPurchase(ctx, input) {
  return runAtomic(async (tx) => {
    let variant;
    if (input.newProduct) {
      variant = await createMinimalVariant(ctx, tx, input.newProduct);
    } else {
      variant = await loadVariant(ctx, input.variantId, { session: tx.session, requireActive: false });
    }
    const conv = conversionFor(variant, input.unit);
    if (!conv) throw ApiError.badRequest(`${variant.name} is not sold by the ${input.unit}.`);

    const seq = await nextSequence(`odp:${ctx.shopId}`, tx);
    const odpNumber = formatNumber('ODP-', seq, 5);

    const odp = await createDoc(
      OnDemandPurchase,
      {
        businessId: ctx.businessId,
        shopId: ctx.shopId,
        odpNumber,
        productVariantId: variant._id,
        name: variant.name,
        unit: input.unit,
        requestedQuantity: input.requestedQuantity,
        purchasedFrom: input.purchasedFrom,
        purchasedFromPhone: input.purchasedFromPhone || '',
        sellingPricePerUnit: input.sellingPricePerUnit || 0,
        customerName: input.customerName || '',
        notes: input.notes || '',
        status: 'PENDING',
        createdBy: ctx.userId,
      },
      tx
    );

    await logAudit(
      ctx,
      {
        category: 'inventory',
        action: 'ondemand.created',
        summary: 'recorded an on-demand purchase request',
        target: odpNumber,
        detail: `${variant.name} · ${input.requestedQuantity} ${input.unit}${input.requestedQuantity === 1 ? '' : 's'} · from ${input.purchasedFrom}`,
        entityType: 'OnDemandPurchase',
        entityId: odp._id,
      },
      tx
    );

    return odpView({ ...odp.toObject(), createdBy: { _id: ctx.userId, name: ctx.user.name, color: ctx.user.color } });
  });
}

/**
 * Step 2: the purchase actually happened — stock lands in this shop now, priced at its real
 * cost, blended into the shop's normal weighted-average cost like any other restock. From this
 * point the item can be sold through the ordinary staff checkout.
 */
export async function markOnDemandPurchased(ctx, id, input) {
  const odp = await OnDemandPurchase.findOne({ _id: id, businessId: ctx.businessId, shopId: ctx.shopId }).lean();
  if (!odp) throw ApiError.notFound('On-demand purchase not found.');
  if (odp.status !== 'PENDING') throw ApiError.badRequest('This purchase has already been bought.');

  const variant = await loadVariant(ctx, odp.productVariantId, { requireActive: false });
  const { conversion, baseQuantity } = toBase(variant, input.unit, input.quantity);
  const totalCost = round2(input.unitCost * input.quantity);
  const unitCostPerBottle = round2(totalCost / baseQuantity);

  return runAtomic(async (tx) => {
    await applyMovement(ctx, tx, {
      variant,
      delta: baseQuantity,
      type: 'ON_DEMAND_PURCHASE',
      restockTotal: totalCost,
      ref: { type: 'OnDemandPurchase', id: odp._id, number: odp.odpNumber },
      reason: `Bought from ${odp.purchasedFrom} for a customer request`,
    });

    const patch = {
      unit: input.unit,
      quantity: input.quantity,
      conversion,
      baseQuantity,
      remainingBaseQuantity: baseQuantity,
      unitCost: unitCostPerBottle,
      totalCost,
      status: 'PURCHASED',
      purchasedAt: new Date(),
    };
    if (input.sellingPricePerUnit) patch.sellingPricePerUnit = input.sellingPricePerUnit;
    await OnDemandPurchase.updateOne({ _id: odp._id }, { $set: patch }, { session: tx.session });
    tx.undo(() => OnDemandPurchase.updateOne({ _id: odp._id }, { $set: { status: 'PENDING', quantity: 0, baseQuantity: 0, remainingBaseQuantity: 0, unitCost: 0, totalCost: 0, purchasedAt: null } }));

    await logAudit(
      ctx,
      {
        category: 'inventory',
        action: 'ondemand.purchased',
        summary: 'bought stock for an on-demand purchase',
        target: odp.odpNumber,
        detail: `${odp.name} · ${input.quantity} ${input.unit}${input.quantity === 1 ? '' : 's'} · ₦${Math.round(totalCost).toLocaleString('en-US')}`,
        entityType: 'OnDemandPurchase',
        entityId: odp._id,
      },
      tx
    );

    const full = await OnDemandPurchase.findById(odp._id).populate('createdBy', 'name color').session(tx.session).lean();
    return { view: odpView(full), variantId: variant._id };
  }).then(async ({ view, variantId }) => {
    // Read after the transaction commits, not inside it — a read without the transaction's own
    // session wouldn't see this purchase's just-written stock yet on a replica set. Shaped like a
    // product-list row so the client can drop it straight into the sale cart (cart.add()).
    const [cartProduct] = await stockRows(ctx, { includeArchived: true, variantIds: [variantId] });
    return { ...view, cartProduct };
  });
}

export async function listOnDemandPurchases(ctx, query) {
  const { page, limit, skip } = pageParams(query, { defaultLimit: 20 });
  const filter = { businessId: ctx.businessId, shopId: ctx.shopId };
  if (query.status) filter.status = query.status;
  const [rows, total] = await Promise.all([
    OnDemandPurchase.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('createdBy', 'name color').lean(),
    OnDemandPurchase.countDocuments(filter),
  ]);
  return { items: rows.map(odpView), total, page, pages: Math.ceil(total / limit) || 1 };
}

export async function getOnDemandPurchase(ctx, id) {
  const odp = await OnDemandPurchase.findOne({ _id: id, businessId: ctx.businessId }).populate('createdBy', 'name color').lean();
  if (!odp) throw ApiError.notFound('On-demand purchase not found.');
  return odpView(odp);
}

/** Abandons a request before purchase, or voids one already bought — returning any unsold stock
 * to the outside world (the sold portion stays sold; its revenue and profit are untouched). */
export async function cancelOnDemandPurchase(ctx, id, input) {
  const odp = await OnDemandPurchase.findOne({ _id: id, businessId: ctx.businessId, shopId: ctx.shopId }).lean();
  if (!odp) throw ApiError.notFound('On-demand purchase not found.');
  if (odp.status === 'CANCELLED') throw ApiError.badRequest('This purchase is already cancelled.');
  if (odp.status === 'SOLD') throw ApiError.badRequest('This purchase has already been fully sold.');

  return runAtomic(async (tx) => {
    if (odp.remainingBaseQuantity > 0) {
      const variant = await loadVariant(ctx, odp.productVariantId, { requireActive: false });
      await applyMovement(ctx, tx, {
        variant,
        delta: -odp.remainingBaseQuantity,
        type: 'ON_DEMAND_PURCHASE',
        ref: { type: 'OnDemandPurchase', id: odp._id, number: odp.odpNumber },
        reason: `Cancelled on-demand purchase${input.reason ? `: ${input.reason}` : ''}`,
      });
    }

    await OnDemandPurchase.updateOne(
      { _id: odp._id },
      { $set: { status: 'CANCELLED', remainingBaseQuantity: 0, cancelledAt: new Date(), cancelReason: input.reason || '' } },
      { session: tx.session }
    );
    tx.undo(() => OnDemandPurchase.updateOne({ _id: odp._id }, { $set: { status: odp.status, remainingBaseQuantity: odp.remainingBaseQuantity, cancelledAt: null, cancelReason: '' } }));

    await logAudit(
      ctx,
      {
        category: 'inventory',
        action: 'ondemand.cancelled',
        summary: 'cancelled an on-demand purchase',
        target: odp.odpNumber,
        detail: odp.name,
        entityType: 'OnDemandPurchase',
        entityId: odp._id,
      },
      tx
    );

    const full = await OnDemandPurchase.findById(odp._id).populate('createdBy', 'name color').session(tx.session).lean();
    return odpView(full);
  });
}

/**
 * Called from inside createSale()'s own transaction, right after a sale line's stock is already
 * deducted from Inventory. Purely bookkeeping: links the sale to whichever on-demand purchase
 * batches (oldest first) it drew from, so each batch's own sold/remaining status stays accurate
 * for audit purposes. Never changes quantities or cost — createSale's normal weighted-average
 * cost (from the shop's Inventory.avgCost, already blended with this purchase's cost at
 * markOnDemandPurchased time) is the only cost figure the sale itself uses.
 */
export async function consumeOnDemandStock(ctx, tx, variantId, baseQuantitySold, saleRef) {
  let remaining = baseQuantitySold;
  const batches = await OnDemandPurchase.find({
    businessId: ctx.businessId,
    shopId: ctx.shopId,
    productVariantId: variantId,
    status: { $in: ['PURCHASED', 'PARTIALLY_SOLD'] },
    remainingBaseQuantity: { $gt: 0 },
  })
    .sort({ createdAt: 1 })
    .session(tx.session)
    .lean();

  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.remainingBaseQuantity, remaining);
    const newRemaining = batch.remainingBaseQuantity - take;
    const newStatus = newRemaining === 0 ? 'SOLD' : 'PARTIALLY_SOLD';
    const link = { saleId: saleRef.id, receiptNumber: saleRef.number, baseQuantity: take, date: new Date() };

    await OnDemandPurchase.updateOne(
      { _id: batch._id },
      { $inc: { remainingBaseQuantity: -take }, $set: { status: newStatus }, $push: { saleLinks: link } },
      { session: tx.session }
    );
    tx.undo(() => OnDemandPurchase.updateOne({ _id: batch._id }, { $inc: { remainingBaseQuantity: take }, $set: { status: batch.status }, $pop: { saleLinks: 1 } }));

    remaining -= take;
  }
}
