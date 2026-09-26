import { Business, Inventory, Product, ProductVariant, Shop, Supplier } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { createDoc, runAtomic, updateDoc } from '../utils/atomic.js';
import { toBase } from '../utils/units.js';
import { applyMovement, listMovements, stockRows } from './inventory.service.js';
import { logAudit } from './audit.service.js';

const CATEGORY_COLORS = {
  'Soft Drink': '#0EA271',
  'Malt Drink': '#D97706',
  Water: '#0EA5E9',
  Juice: '#F97316',
  'Energy Drink': '#6366F1',
  Beer: '#65A30D',
};
const naira = (n) => '₦' + Math.round(n).toLocaleString('en-US');

export async function listProducts(ctx, query) {
  const status = query.status === 'ARCHIVED' ? 'archived' : query.stock;
  const rows = await stockRows(ctx, {
    includeArchived: query.status === 'ARCHIVED',
    q: query.q,
    category: query.category,
    status,
  });
  const items = query.status === 'ARCHIVED' ? rows.filter((r) => r.status === 'archived') : rows;
  return { items, total: items.length };
}

export async function listCategories(ctx) {
  const business = await Business.findById(ctx.businessId).lean();
  const used = await Product.distinct('category', { businessId: ctx.businessId });
  return [...new Set([...(business?.categories || []), ...used])].sort();
}

export async function getProduct(ctx, id, { withHistory }) {
  const product = await Product.findOne({ _id: id, businessId: ctx.businessId }).lean();
  if (!product) throw ApiError.notFound('Product not found.');
  const variants = await stockRows(ctx, { includeArchived: true, productIds: [product._id] });
  const supplier = product.supplierId ? await Supplier.findById(product.supplierId, 'name').lean() : null;
  const result = {
    product: { ...product, id: String(product._id), supplier: supplier ? { id: String(supplier._id), name: supplier.name } : null },
    variants,
  };
  if (withHistory && variants.length) {
    const history = await Promise.all(variants.map((v) => listMovements(ctx, { variantId: v.variantId, limit: 20 })));
    result.movements = history
      .flatMap((h) => h.items)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 20);
  }
  return result;
}

function variantDoc(ctx, product, v) {
  return {
    businessId: ctx.businessId,
    productId: product._id,
    name: `${product.name} ${v.size}`,
    size: v.size,
    costPrice: v.costPrice,
    sellingPrice: v.sellingPrice,
    unitConversions: { bottle: 1, ...v.unitConversions },
    unitPrices: v.unitPrices,
    lowStockThreshold: v.lowStockThreshold,
    image: v.image || '',
  };
}

async function assertSupplier(ctx, supplierId) {
  if (!supplierId) return;
  const ok = await Supplier.exists({ _id: supplierId, businessId: ctx.businessId });
  if (!ok) throw ApiError.badRequest('Supplier not found.');
}

/** Creates inventory rows for a new variant in every shop, and records opening stock. */
async function setUpStock(ctx, tx, variant, openingStock) {
  const shops = await Shop.find({ businessId: ctx.businessId }, '_id').session(tx.session).lean();
  for (const shop of shops) {
    await createDoc(
      Inventory,
      { businessId: ctx.businessId, shopId: shop._id, productVariantId: variant._id, quantity: 0, avgCost: variant.costPrice },
      tx
    );
  }
  if (openingStock?.quantity > 0) {
    const { baseQuantity } = toBase(variant, openingStock.unit, openingStock.quantity);
    await applyMovement(ctx, tx, {
      variant,
      delta: baseQuantity,
      type: 'OPENING_STOCK',
      restockTotal: baseQuantity * variant.costPrice,
      ref: { type: 'Product', id: variant.productId, number: 'Opening stock' },
      reason: 'Opening stock',
    });
  }
}

export async function createProduct(ctx, input) {
  await assertSupplier(ctx, input.supplierId);
  const sizes = input.variants.map((v) => v.size.toLowerCase());
  if (new Set(sizes).size !== sizes.length) throw ApiError.badRequest('Each size must be different.');

  return runAtomic(async (tx) => {
    const product = await createDoc(
      Product,
      {
        businessId: ctx.businessId,
        name: input.name,
        brand: input.brand || '',
        category: input.category,
        description: input.description || '',
        image: input.image || '',
        color: input.color || CATEGORY_COLORS[input.category] || '#059669',
        shape: input.shape || 'bottle',
        supplierId: input.supplierId || null,
      },
      tx
    );
    for (const v of input.variants) {
      const variant = await createDoc(ProductVariant, variantDoc(ctx, product, v), tx);
      await setUpStock(ctx, tx, variant.toObject(), v.openingStock);
    }
    await logAudit(
      ctx,
      {
        category: 'product',
        action: 'product.created',
        summary: 'added product',
        target: product.name,
        detail: input.variants.map((v) => v.size).join(', '),
        entityType: 'Product',
        entityId: product._id,
      },
      tx
    );
    return { id: String(product._id) };
  });
}

export async function updateProduct(ctx, id, input) {
  const product = await Product.findOne({ _id: id, businessId: ctx.businessId });
  if (!product) throw ApiError.notFound('Product not found.');
  if (input.supplierId !== undefined) await assertSupplier(ctx, input.supplierId);

  return runAtomic(async (tx) => {
    const fields = ['name', 'brand', 'category', 'description', 'image', 'color', 'shape', 'supplierId'];
    const $set = {};
    for (const f of fields) if (input[f] !== undefined) $set[f] = input[f];
    const updated = Object.keys($set).length ? await updateDoc(Product, product, { $set }, tx) : product;
    const renamed = input.name && input.name !== product.name;

    const existing = await ProductVariant.find({ productId: product._id }).session(tx.session);
    if (renamed) {
      for (const v of existing) {
        if (!input.variants?.some((iv) => iv.id === String(v._id))) {
          await updateDoc(ProductVariant, v, { $set: { name: `${updated.name} ${v.size}` } }, tx);
        }
      }
    }

    for (const v of input.variants || []) {
      if (v.id) {
        const current = existing.find((e) => String(e._id) === v.id);
        if (!current) throw ApiError.badRequest('One of the sizes does not belong to this product.');
        const doc = variantDoc(ctx, updated, v);
        delete doc.businessId;
        delete doc.productId;
        if (current.sellingPrice !== v.sellingPrice) {
          await logAudit(
            ctx,
            { category: 'product', action: 'product.price_changed', summary: 'changed selling price', target: doc.name, detail: `${naira(current.sellingPrice)} → ${naira(v.sellingPrice)}`, entityType: 'ProductVariant', entityId: current._id },
            tx
          );
        }
        if (current.costPrice !== v.costPrice) {
          await logAudit(
            ctx,
            { category: 'product', action: 'product.cost_changed', summary: 'changed cost price', target: doc.name, detail: `${naira(current.costPrice)} → ${naira(v.costPrice)}`, entityType: 'ProductVariant', entityId: current._id },
            tx
          );
          // Only reset the average cost where there is no stock to average against
          await Inventory.updateMany({ productVariantId: current._id, quantity: 0 }, { $set: { avgCost: v.costPrice } }, { session: tx.session });
        }
        await updateDoc(ProductVariant, current, { $set: doc }, tx);
      } else {
        if (existing.some((e) => e.size.toLowerCase() === v.size.toLowerCase())) {
          throw ApiError.badRequest(`A ${v.size} size already exists for this product.`);
        }
        const variant = await createDoc(ProductVariant, variantDoc(ctx, updated, v), tx);
        await setUpStock(ctx, tx, variant.toObject(), v.openingStock);
        await logAudit(ctx, { category: 'product', action: 'product.variant_added', summary: 'added size', target: variant.name, entityType: 'ProductVariant', entityId: variant._id }, tx);
      }
    }
    if (!input.variants && Object.keys($set).length) {
      await logAudit(ctx, { category: 'product', action: 'product.updated', summary: 'updated product', target: updated.name, entityType: 'Product', entityId: product._id }, tx);
    }
    return { id: String(product._id) };
  });
}

export async function setProductStatus(ctx, id, status) {
  const product = await Product.findOne({ _id: id, businessId: ctx.businessId });
  if (!product) throw ApiError.notFound('Product not found.');
  product.status = status;
  product.archivedAt = status === 'ARCHIVED' ? new Date() : undefined;
  await product.save();
  const rows = await stockRows(ctx, { includeArchived: true, productIds: [product._id] });
  const stock = rows.reduce((s, r) => s + r.quantity, 0);
  await logAudit(ctx, {
    category: 'product',
    action: status === 'ARCHIVED' ? 'product.archived' : 'product.restored',
    summary: status === 'ARCHIVED' ? 'archived product' : 'restored product',
    target: product.name,
    detail: status === 'ARCHIVED' && stock ? `${stock.toLocaleString('en-US')} bottles still recorded` : '',
    entityType: 'Product',
    entityId: product._id,
  });
  return { id: String(product._id), status };
}
