import mongoose from 'mongoose';
import { Purchase, PurchaseItem, Supplier } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { createDoc, createDocs, runAtomic } from '../utils/atomic.js';
import { toBase } from '../utils/units.js';
import { formatNumber, nextSequence } from '../utils/sequence.js';
import { pageParams } from '../utils/serialize.js';
import { applyMovement, loadVariant } from './inventory.service.js';
import { logAudit } from './audit.service.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const naira = (n) => '₦' + Math.round(n).toLocaleString('en-US');

/**
 * Restock: records a purchase from a supplier, adds stock and updates the
 * weighted average cost, all in one atomic write.
 */
export async function createPurchase(ctx, { supplierId, items, notes }) {
  const supplier = await Supplier.findOne({ _id: supplierId, businessId: ctx.businessId, status: 'ACTIVE' }).lean();
  if (!supplier) throw ApiError.badRequest('Supplier not found.');

  const lines = [];
  for (const item of items) {
    const variant = await loadVariant(ctx, item.variantId);
    const { conversion, baseQuantity } = toBase(variant, item.unit, item.quantity);
    const lineTotal = item.quantity * item.costPerUnit;
    lines.push({ variant, item, conversion, baseQuantity, lineTotal });
  }

  return runAtomic(async (tx) => {
    const number = formatNumber('PO-', await nextSequence(`purchase:${ctx.shopId}`, tx), 5);
    const purchaseId = new mongoose.Types.ObjectId();

    for (const l of lines) {
      await applyMovement(ctx, tx, {
        variant: l.variant,
        delta: l.baseQuantity,
        type: 'RESTOCK',
        restockTotal: l.lineTotal,
        ref: { type: 'Purchase', id: purchaseId, number },
        reason: `Restock from ${supplier.name}${notes ? ` · ${notes}` : ''}`,
      });
    }

    const totalCost = lines.reduce((s, l) => s + l.lineTotal, 0);
    const purchase = await createDoc(
      Purchase,
      {
        _id: purchaseId,
        businessId: ctx.businessId,
        shopId: ctx.shopId,
        supplierId: supplier._id,
        purchaseNumber: number,
        itemCount: lines.length,
        totalCost,
        notes: notes || '',
        createdBy: ctx.userId,
      },
      tx
    );
    await createDocs(
      PurchaseItem,
      lines.map((l) => ({
        purchaseId,
        businessId: ctx.businessId,
        shopId: ctx.shopId,
        supplierId: supplier._id,
        productVariantId: l.variant._id,
        unit: l.item.unit,
        quantity: l.item.quantity,
        conversion: l.conversion,
        baseQuantity: l.baseQuantity,
        costPerUnit: l.item.costPerUnit,
        costPerBase: Math.round((l.lineTotal / l.baseQuantity) * 100) / 100,
        lineTotal: l.lineTotal,
      })),
      tx
    );
    for (const l of lines) {
      await logAudit(
        ctx,
        {
          category: 'inventory',
          action: 'inventory.restocked',
          summary: 'restocked',
          target: l.variant.name,
          detail: `+${plural(l.item.quantity, l.item.unit)} · ${naira(l.lineTotal)}`,
          entityType: 'Purchase',
          entityId: purchaseId,
        },
        tx
      );
    }
    return { id: String(purchase._id), purchaseNumber: number, totalCost };
  });
}

export async function listPurchases(ctx, query) {
  const { page, limit, skip } = pageParams(query);
  const filter = { shopId: ctx.shopId };
  if (query.supplierId) filter.supplierId = query.supplierId;
  const [purchases, total] = await Promise.all([
    Purchase.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('supplierId', 'name').populate('createdBy', 'name').lean(),
    Purchase.countDocuments(filter),
  ]);
  const items = await PurchaseItem.find({ purchaseId: { $in: purchases.map((p) => p._id) } })
    .populate('productVariantId', 'name size')
    .lean();
  return {
    items: purchases.map((p) => ({
      id: String(p._id),
      purchaseNumber: p.purchaseNumber,
      totalCost: p.totalCost,
      notes: p.notes,
      createdAt: p.createdAt,
      supplier: p.supplierId ? { id: String(p.supplierId._id), name: p.supplierId.name } : null,
      createdBy: p.createdBy ? { id: String(p.createdBy._id), name: p.createdBy.name } : null,
      items: items
        .filter((i) => String(i.purchaseId) === String(p._id))
        .map((i) => ({
          variantId: String(i.productVariantId?._id),
          name: i.productVariantId?.name,
          unit: i.unit,
          quantity: i.quantity,
          baseQuantity: i.baseQuantity,
          costPerUnit: i.costPerUnit,
          lineTotal: i.lineTotal,
        })),
    })),
    total,
    page,
    pages: Math.ceil(total / limit) || 1,
  };
}
