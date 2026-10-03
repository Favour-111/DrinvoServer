import mongoose from 'mongoose';
import { Borrowing, ProductVariant } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { createDoc, runAtomic } from '../utils/atomic.js';
import { conversionFor } from '../utils/units.js';
import { formatNumber, nextSequence } from '../utils/sequence.js';
import { pageParams } from '../utils/serialize.js';
import { applyMovement } from './inventory.service.js';
import { logAudit } from './audit.service.js';

function classifyStatus(items) {
  const total = items.reduce((s, i) => s + i.baseQuantity, 0);
  const returned = items.reduce((s, i) => s + i.returnedBaseQuantity, 0);
  if (returned <= 0) return 'OUTSTANDING';
  if (returned < total) return 'PARTIALLY_RETURNED';
  return 'RETURNED';
}

function personView(p) {
  if (!p) return null;
  if (p.name) return { id: String(p._id), name: p.name, color: p.color || null };
  return { id: String(p), name: null };
}

function borrowingView(b) {
  const totalBorrowed = b.items.reduce((s, i) => s + i.baseQuantity, 0);
  const totalReturned = b.items.reduce((s, i) => s + i.returnedBaseQuantity, 0);
  const overdue = b.status !== 'RETURNED' && b.expectedReturnDate && new Date(b.expectedReturnDate) < new Date();
  return {
    id: String(b._id),
    borrowNumber: b.borrowNumber,
    shopId: String(b.shopId),
    direction: b.direction,
    counterpartyName: b.counterpartyName,
    counterpartyPhone: b.counterpartyPhone || '',
    status: b.status,
    overdue,
    expectedReturnDate: b.expectedReturnDate || null,
    notes: b.notes,
    createdBy: personView(b.createdBy),
    createdAt: b.createdAt,
    totalBorrowed,
    totalReturned,
    totalRemaining: totalBorrowed - totalReturned,
    items: b.items.map((i) => ({
      variantId: String(i.productVariantId),
      name: i.name,
      countedUnits: i.countedUnits,
      baseQuantity: i.baseQuantity,
      returnedBaseQuantity: i.returnedBaseQuantity,
      remainingBaseQuantity: i.baseQuantity - i.returnedBaseQuantity,
    })),
    returns: (b.returns || []).map((r) => ({
      date: r.date,
      by: personView(r.by),
      notes: r.notes,
      items: r.items.map((i) => ({ variantId: String(i.productVariantId), name: i.name, countedUnits: i.countedUnits, baseQuantity: i.baseQuantity })),
    })),
  };
}

/** Converts `[{unit, quantity}]` into countedUnits (with each unit's conversion) plus the total
 * in bottles — the same multi-unit math used by restock/transfer/stock-count. */
function resolveCounts(variant, counts) {
  const countedUnits = counts.map(({ unit, quantity }) => {
    const conv = conversionFor(variant, unit);
    if (!conv) throw ApiError.badRequest(`${variant.name} is not sold by the ${unit}.`);
    return { unit, quantity, conversion: conv };
  });
  const baseQuantity = countedUnits.reduce((s, c) => s + c.quantity * c.conversion, 0);
  return { countedUnits, baseQuantity };
}

/**
 * Lending/borrowing drinks to or from someone outside the business (never one of our own
 * registered shops — those are moved with Stock Transfers instead). Moves inventory immediately
 * but never touches Sale/SaleItem/Payment, so it can never show up as revenue or profit.
 */
export async function createBorrowing(ctx, input) {
  const variantIds = [...new Set(input.items.map((i) => i.variantId))];
  if (variantIds.length !== input.items.length) throw ApiError.badRequest('Each product can only appear once — combine its units into one line.');
  const variants = await ProductVariant.find({ _id: { $in: variantIds }, businessId: ctx.businessId }).lean();
  const byId = new Map(variants.map((v) => [String(v._id), v]));

  return runAtomic(async (tx) => {
    const seq = await nextSequence(`borrow:${ctx.shopId}`, tx);
    const borrowNumber = formatNumber('BR-', seq, 5);
    const borrowId = new mongoose.Types.ObjectId();

    const items = [];
    for (const item of input.items) {
      const variant = byId.get(item.variantId);
      if (!variant) throw ApiError.notFound('Product not found.');
      const { countedUnits, baseQuantity } = resolveCounts(variant, item.counts);
      if (baseQuantity <= 0) throw ApiError.badRequest(`Enter a quantity for ${variant.name}.`);

      const delta = input.direction === 'LENT' ? -baseQuantity : baseQuantity;
      await applyMovement(ctx, tx, {
        variant,
        delta,
        type: input.direction === 'LENT' ? 'BORROW_OUT' : 'BORROW_IN',
        ref: { type: 'Borrowing', id: borrowId, number: borrowNumber },
        reason: input.direction === 'LENT' ? `Lent to ${input.counterpartyName}` : `Borrowed from ${input.counterpartyName}`,
      });

      items.push({ productVariantId: variant._id, name: variant.name, countedUnits, baseQuantity, returnedBaseQuantity: 0 });
    }

    const borrowing = await createDoc(
      Borrowing,
      {
        _id: borrowId,
        businessId: ctx.businessId,
        shopId: ctx.shopId,
        borrowNumber,
        direction: input.direction,
        counterpartyName: input.counterpartyName,
        counterpartyPhone: input.counterpartyPhone || '',
        items,
        expectedReturnDate: input.expectedReturnDate || null,
        notes: input.notes || '',
        status: 'OUTSTANDING',
        createdBy: ctx.userId,
      },
      tx
    );

    await logAudit(ctx, {
      category: 'inventory',
      action: 'borrowing.created',
      summary: input.direction === 'LENT' ? 'recorded drinks lent out' : 'recorded drinks borrowed in',
      target: borrowNumber,
      detail: `${items.length} product${items.length === 1 ? '' : 's'} · ${input.counterpartyName}`,
      entityType: 'Borrowing',
      entityId: borrowing._id,
    }, tx);

    return borrowingView({ ...borrowing.toObject(), createdBy: { _id: ctx.userId, name: ctx.user.name, color: ctx.user.color } });
  });
}

export async function listBorrowings(ctx, query) {
  const { page, limit, skip } = pageParams(query, { defaultLimit: 20 });
  const filter = { businessId: ctx.businessId, shopId: ctx.shopId };
  if (query.direction) filter.direction = query.direction;
  // overdue is a derived property (not stored), so it has to be expressed as a real query
  // condition here — filtering the page's results in JS after the fact would leave `total`
  // and `pages` counting the unfiltered set, breaking pagination.
  if (query.overdue) {
    filter.status = query.status || { $ne: 'RETURNED' };
    filter.expectedReturnDate = { $lt: new Date() };
  } else if (query.status) {
    filter.status = query.status;
  }
  const [rows, total] = await Promise.all([
    Borrowing.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('createdBy', 'name color').lean(),
    Borrowing.countDocuments(filter),
  ]);
  return { items: rows.map(borrowingView), total, page, pages: Math.ceil(total / limit) || 1 };
}

export async function getBorrowing(ctx, id) {
  const borrowing = await Borrowing.findOne({ _id: id, businessId: ctx.businessId }).populate('createdBy', 'name color').populate('returns.by', 'name').lean();
  if (!borrowing) throw ApiError.notFound('Borrowing record not found.');
  return borrowingView(borrowing);
}

export async function returnBorrowing(ctx, id, input) {
  const borrowing = await Borrowing.findOne({ _id: id, businessId: ctx.businessId }).lean();
  if (!borrowing) throw ApiError.notFound('Borrowing record not found.');
  if (borrowing.status === 'RETURNED') throw ApiError.badRequest('Everything on this record has already been returned.');

  const variantIds = [...new Set(input.items.map((i) => i.variantId))];
  const variants = await ProductVariant.find({ _id: { $in: variantIds }, businessId: ctx.businessId }).lean();
  const byId = new Map(variants.map((v) => [String(v._id), v]));

  return runAtomic(async (tx) => {
    const returnedNow = [];
    const incOps = {};
    const undoIncOps = {};

    for (const item of input.items) {
      const variant = byId.get(item.variantId);
      if (!variant) throw ApiError.notFound('Product not found.');
      const idx = borrowing.items.findIndex((i) => String(i.productVariantId) === item.variantId);
      if (idx === -1) throw ApiError.badRequest(`${variant.name} wasn’t part of this borrowing record.`);
      const line = borrowing.items[idx];

      const { countedUnits, baseQuantity } = resolveCounts(variant, item.counts);
      if (baseQuantity <= 0) continue;
      const remaining = line.baseQuantity - line.returnedBaseQuantity;
      if (baseQuantity > remaining) {
        throw ApiError.badRequest(`Only ${remaining} bottle${remaining === 1 ? '' : 's'} of ${variant.name} ${remaining === 1 ? 'is' : 'are'} still outstanding.`);
      }

      // LENT: the borrower returns it, so our stock increases. BORROWED: we hand it back, so ours decreases.
      const delta = borrowing.direction === 'LENT' ? baseQuantity : -baseQuantity;
      await applyMovement(ctx, tx, {
        variant,
        delta,
        type: borrowing.direction === 'LENT' ? 'BORROW_RETURN_IN' : 'BORROW_RETURN_OUT',
        ref: { type: 'Borrowing', id: borrowing._id, number: borrowing.borrowNumber },
        reason: borrowing.direction === 'LENT' ? `Returned by ${borrowing.counterpartyName}` : `Returned to ${borrowing.counterpartyName}`,
      });

      incOps[`items.${idx}.returnedBaseQuantity`] = baseQuantity;
      undoIncOps[`items.${idx}.returnedBaseQuantity`] = -baseQuantity;
      returnedNow.push({ productVariantId: variant._id, name: variant.name, countedUnits, baseQuantity });
    }

    if (!returnedNow.length) throw ApiError.badRequest('Enter a quantity to return.');

    const updatedItems = borrowing.items.map((i, idx) => {
      const key = `items.${idx}.returnedBaseQuantity`;
      return incOps[key] ? { ...i, returnedBaseQuantity: i.returnedBaseQuantity + incOps[key] } : i;
    });
    const status = classifyStatus(updatedItems);
    const returnEntry = { date: new Date(), by: ctx.userId, items: returnedNow, notes: input.notes || '' };

    await Borrowing.updateOne({ _id: borrowing._id }, { $inc: incOps, $push: { returns: returnEntry }, $set: { status } }, { session: tx.session });
    tx.undo(() => Borrowing.updateOne({ _id: borrowing._id }, { $inc: undoIncOps, $pop: { returns: 1 }, $set: { status: borrowing.status } }));

    await logAudit(
      ctx,
      {
        category: 'inventory',
        action: 'borrowing.returned',
        summary: 'recorded a borrowed-drinks return',
        target: borrowing.borrowNumber,
        detail: `${returnedNow.length} product${returnedNow.length === 1 ? '' : 's'} · now ${status.toLowerCase().replace('_', ' ')}`,
        entityType: 'Borrowing',
        entityId: borrowing._id,
      },
      tx
    );

    return borrowingView({ ...borrowing, items: updatedItems, status, returns: [...(borrowing.returns || []), returnEntry] });
  });
}
