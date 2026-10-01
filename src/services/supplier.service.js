import { Product, Purchase, PurchaseItem, Supplier } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex } from '../utils/serialize.js';
import { logAudit } from './audit.service.js';
import { listPurchases } from './purchase.service.js';

function shopScope(ctx) {
  return { businessId: ctx.businessId, $or: [{ shopIds: { $size: 0 } }, { shopIds: ctx.shopId }] };
}

export async function listSuppliers(ctx, { q } = {}) {
  const filter = { ...shopScope(ctx), status: 'ACTIVE' };
  if (q) filter.name = new RegExp(escapeRegex(q), 'i');
  const suppliers = await Supplier.find(filter).sort({ name: 1 }).lean();
  const ids = suppliers.map((s) => s._id);
  const [totals, products] = await Promise.all([
    Purchase.aggregate([
      { $match: { shopId: ctx.shopId, supplierId: { $in: ids } } },
      { $group: { _id: '$supplierId', total: { $sum: '$totalCost' }, count: { $sum: 1 }, last: { $max: '$createdAt' } } },
    ]),
    Product.find({ businessId: ctx.businessId, supplierId: { $in: ids }, status: 'ACTIVE' }, 'name supplierId').lean(),
  ]);
  return suppliers.map((s) => {
    const t = totals.find((x) => String(x._id) === String(s._id));
    return {
      id: String(s._id),
      name: s.name,
      contacts: s.contacts || [],
      address: s.address,
      totalPurchases: t?.total || 0,
      purchaseCount: t?.count || 0,
      lastPurchaseAt: t?.last || null,
      products: products.filter((p) => String(p.supplierId) === String(s._id)).map((p) => ({ id: String(p._id), name: p.name })),
      createdAt: s.createdAt,
    };
  });
}

export async function createSupplier(ctx, input) {
  const supplier = await Supplier.create({ ...input, businessId: ctx.businessId });
  await logAudit(ctx, { category: 'supplier', action: 'supplier.created', summary: 'added supplier', target: supplier.name, entityType: 'Supplier', entityId: supplier._id });
  return { id: String(supplier._id) };
}

export async function updateSupplier(ctx, id, input) {
  const supplier = await Supplier.findOneAndUpdate({ _id: id, businessId: ctx.businessId }, { $set: input }, { new: true, runValidators: true });
  if (!supplier) throw ApiError.notFound('Supplier not found.');
  await logAudit(ctx, { category: 'supplier', action: 'supplier.updated', summary: 'updated supplier', target: supplier.name, entityType: 'Supplier', entityId: supplier._id });
  return { id: String(supplier._id) };
}

export async function getSupplier(ctx, id) {
  const supplier = await Supplier.findOne({ _id: id, ...shopScope(ctx) }).lean();
  if (!supplier) throw ApiError.notFound('Supplier not found.');
  const [purchases, linked, suppliedVariantIds] = await Promise.all([
    listPurchases(ctx, { supplierId: supplier._id, limit: 100 }),
    Product.find({ businessId: ctx.businessId, supplierId: supplier._id }).lean(),
    PurchaseItem.distinct('productVariantId', { shopId: ctx.shopId, supplierId: supplier._id }),
  ]);
  const totals = purchases.items.reduce((s, p) => s + p.totalCost, 0);
  return {
    supplier: { ...supplier, id: String(supplier._id) },
    stats: {
      totalPurchases: totals,
      purchaseCount: purchases.total,
      lastPurchaseAt: purchases.items[0]?.createdAt || null,
      productCount: linked.length,
      variantsSupplied: suppliedVariantIds.length,
    },
    products: linked.map((p) => ({ id: String(p._id), name: p.name, category: p.category, color: p.color, shape: p.shape, image: p.image })),
    purchases: purchases.items,
  };
}
