import { Inventory, ProductVariant, StockCount } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { conversionFor } from '../utils/units.js';
import { formatNumber, nextSequence } from '../utils/sequence.js';
import { pageParams } from '../utils/serialize.js';
import { logAudit } from './audit.service.js';

function classify(expected, physical) {
  const difference = physical - expected;
  return { difference, type: difference === 0 ? 'MATCHED' : difference > 0 ? 'OVERAGE' : 'SHORTAGE' };
}

function personView(p) {
  if (!p) return null;
  if (p.name) return { id: String(p._id), name: p.name, color: p.color || null };
  return { id: String(p), name: null };
}

function countView(c) {
  const summary = c.items.reduce((acc, i) => ({ ...acc, [i.type]: acc[i.type] + 1 }), { MATCHED: 0, SHORTAGE: 0, OVERAGE: 0 });
  return {
    id: String(c._id),
    countNumber: c.countNumber,
    shopId: String(c.shopId),
    status: c.status,
    notes: c.notes,
    performedBy: personView(c.performedBy),
    reviewedBy: personView(c.reviewedBy),
    reviewedAt: c.reviewedAt || null,
    createdAt: c.createdAt,
    items: c.items.map((i) => ({
      variantId: String(i.productVariantId),
      name: i.name,
      countedUnits: i.countedUnits,
      expectedQuantity: i.expectedQuantity,
      physicalQuantity: i.physicalQuantity,
      difference: i.difference,
      type: i.type,
      notes: i.notes,
    })),
    summary,
  };
}

/**
 * Records a physical count against the stock snapshot *right now* — never changes inventory.
 * Each line's physical quantity can combine several units (e.g. 4 cartons + 5 bottles),
 * exactly like the stock actually sits on the shelf; each unit is converted to bottles via
 * the product's own conversion rules before summing, same as everywhere else in the app.
 */
export async function createStockCount(ctx, input) {
  const variantIds = [...new Set(input.items.map((i) => i.variantId))];
  const [inventories, variants] = await Promise.all([
    Inventory.find({ shopId: ctx.shopId, productVariantId: { $in: variantIds } }).lean(),
    ProductVariant.find({ _id: { $in: variantIds }, businessId: ctx.businessId }).lean(),
  ]);
  const invByVariant = new Map(inventories.map((i) => [String(i.productVariantId), i]));
  const variantById = new Map(variants.map((v) => [String(v._id), v]));

  const items = input.items.map((item) => {
    const variant = variantById.get(item.variantId);
    if (!variant) throw ApiError.notFound('Product not found.');
    const countedUnits = item.counts.map(({ unit, quantity }) => {
      const conv = conversionFor(variant, unit);
      if (!conv) throw ApiError.badRequest(`${variant.name} is not sold by the ${unit}.`);
      return { unit, quantity, conversion: conv };
    });
    const physicalQuantity = countedUnits.reduce((s, c) => s + c.quantity * c.conversion, 0);
    const expectedQuantity = invByVariant.get(item.variantId)?.quantity || 0;
    const { difference, type } = classify(expectedQuantity, physicalQuantity);
    return { productVariantId: variant._id, name: variant.name, countedUnits, expectedQuantity, physicalQuantity, difference, type, notes: item.notes || '' };
  });

  const seq = await nextSequence(`stockcount:${ctx.shopId}`);
  const countNumber = formatNumber('SC-', seq, 5);
  const count = await StockCount.create({ businessId: ctx.businessId, shopId: ctx.shopId, countNumber, items, notes: input.notes || '', performedBy: ctx.userId });

  const summary = items.reduce((acc, i) => ({ ...acc, [i.type]: acc[i.type] + 1 }), { MATCHED: 0, SHORTAGE: 0, OVERAGE: 0 });
  await logAudit(ctx, {
    category: 'inventory',
    action: 'stockcount.submitted',
    summary: 'submitted a physical stock count',
    target: countNumber,
    detail: `${items.length} product${items.length === 1 ? '' : 's'} counted · ${summary.SHORTAGE} shortage, ${summary.OVERAGE} overage`,
    entityType: 'StockCount',
    entityId: count._id,
  });

  return countView({ ...count.toObject(), performedBy: { _id: ctx.userId, name: ctx.user.name, color: ctx.user.color } });
}

export async function listStockCounts(ctx, query) {
  const { page, limit, skip } = pageParams(query, { defaultLimit: 20 });
  const filter = { businessId: ctx.businessId, shopId: ctx.shopId };
  if (query.status) filter.status = query.status;
  // Filtering in JS after the count would leave `total`/`pages` describing the unfiltered set —
  // express it as a real query condition instead so pagination stays correct.
  if (query.hasDifference) filter.items = { $elemMatch: { type: { $in: ['SHORTAGE', 'OVERAGE'] } } };
  const [rows, total] = await Promise.all([
    StockCount.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('performedBy', 'name color').populate('reviewedBy', 'name').lean(),
    StockCount.countDocuments(filter),
  ]);
  return { items: rows.map(countView), total, page, pages: Math.ceil(total / limit) || 1 };
}

export async function getStockCount(ctx, id) {
  const count = await StockCount.findOne({ _id: id, businessId: ctx.businessId }).populate('performedBy', 'name color').populate('reviewedBy', 'name').lean();
  if (!count) throw ApiError.notFound('Stock count not found.');
  return countView(count);
}

/** Admin marks a count as looked at. Purely a review flag — resolving a difference (if any)
 * is a separate, ordinary stock adjustment the admin records themselves, referencing this count. */
export async function reviewStockCount(ctx, id) {
  const count = await StockCount.findOneAndUpdate(
    { _id: id, businessId: ctx.businessId },
    { $set: { status: 'REVIEWED', reviewedBy: ctx.userId, reviewedAt: new Date() } },
    { new: true }
  )
    .populate('performedBy', 'name color')
    .populate('reviewedBy', 'name');
  if (!count) throw ApiError.notFound('Stock count not found.');
  await logAudit(ctx, { category: 'inventory', action: 'stockcount.reviewed', summary: 'marked a physical count as reviewed', target: count.countNumber, entityType: 'StockCount', entityId: count._id });
  return countView(count.toObject());
}
