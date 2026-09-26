import mongoose from 'mongoose';
import { CreditAccount, CreditPayment, Payment, ProductVariant, Refund, Return, ReturnItem, Sale, SaleItem } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { createDoc, createDocs, runAtomic, updateDoc } from '../utils/atomic.js';
import { formatNumber, nextSequence } from '../utils/sequence.js';
import { pageParams } from '../utils/serialize.js';
import { applyMovement } from './inventory.service.js';
import { bumpCreditAccount } from './customer.service.js';
import { logAudit } from './audit.service.js';

const naira = (n) => '₦' + Math.round(n).toLocaleString('en-US');
const round2 = (n) => Math.round(n * 100) / 100;
const netOf = (s) => s.total - s.returnedAmount - s.refundedAmount;

async function loadSale(ctx, id) {
  const sale = await Sale.findOne({ _id: id, shopId: ctx.shopId });
  if (!sale) throw ApiError.notFound('Sale not found.');
  return sale;
}

async function creditAccountFor(ctx, sale, tx) {
  if (!sale.customerId) return null;
  return CreditAccount.findOne({ shopId: ctx.shopId, customerId: sale.customerId }).session(tx.session);
}

/**
 * Returns items from a sale. The original sale is kept; a Return and a linked
 * Refund are created, stock goes back (unless the goods are unsellable), and
 * the sale's net revenue and cost are reduced.
 */
export async function processReturn(ctx, saleId, input) {
  const sale = await loadSale(ctx, saleId);
  if (sale.status === 'VOIDED') throw ApiError.conflict('This sale was voided.');
  if (sale.status === 'RETURNED') throw ApiError.conflict('Everything on this sale has already been returned.');

  const saleItems = await SaleItem.find({ saleId: sale._id });
  const lines = [];
  for (const req of input.items) {
    const si = saleItems.find((i) => String(i._id) === req.saleItemId);
    if (!si) throw ApiError.badRequest('An item is not part of this sale.');
    const remaining = si.quantity - si.returnedQuantity;
    if (req.quantity > remaining) {
      throw ApiError.badRequest(`Only ${remaining} ${si.unit}${remaining === 1 ? '' : 's'} of ${si.variantName} can still be returned.`);
    }
    const baseQuantity = req.quantity * si.conversion;
    lines.push({ si, quantity: req.quantity, baseQuantity, amount: req.quantity * si.unitPrice, cost: round2(baseQuantity * si.unitCost) });
  }
  const amount = lines.reduce((s, l) => s + l.amount, 0);
  if (amount > netOf(sale) + 0.001) {
    throw ApiError.conflict(`The refund of ${naira(amount)} is more than the ${naira(netOf(sale))} left on this sale.`);
  }
  // Credit sales are always refunded by reducing the balance. Part-payment sales can go either way.
  const refundMethod = sale.paymentMethod === 'CREDIT' ? 'CREDIT' : input.refundMethod;
  if (refundMethod === 'CREDIT' && sale.paymentMethod !== 'CREDIT') {
    if (sale.paymentMethod !== 'PART') throw ApiError.badRequest('Choose Cash, POS or Transfer for the refund.');
    const account = await CreditAccount.findOne({ shopId: ctx.shopId, customerId: sale.customerId }).lean();
    const owed = Math.max(0, (account?.totalCredit || 0) - (account?.totalPaid || 0));
    if (amount > owed + 0.001) {
      throw ApiError.badRequest(`The customer only owes ${naira(owed)}. Refund this return by Cash, POS or Transfer instead.`);
    }
  }
  const isCredit = refundMethod === 'CREDIT';

  return runAtomic(async (tx) => {
    const returnNumber = formatNumber('RET-', await nextSequence(`return:${ctx.shopId}`, tx));
    const returnId = new mongoose.Types.ObjectId();
    let restockedCost = 0;

    // Re-check inside the transaction so two simultaneous returns can't over-return
    const current = await SaleItem.find({ saleId: sale._id }).session(tx.session);
    for (const l of lines) {
      const fresh = current.find((i) => String(i._id) === String(l.si._id));
      if (fresh.returnedQuantity + l.quantity > fresh.quantity) {
        throw ApiError.conflict(`${l.si.variantName} was already returned. Refresh and try again.`);
      }
      l.si = fresh;
    }

    for (const l of lines) {
      if (input.restock) {
        const variant = await ProductVariant.findById(l.si.productVariantId).session(tx.session).lean();
        await applyMovement(ctx, tx, {
          variant,
          delta: l.baseQuantity,
          type: 'CUSTOMER_RETURN',
          restockTotal: l.cost,
          ref: { type: 'Return', id: returnId, number: returnNumber },
          reason: `Customer return from ${sale.receiptNumber}: ${input.reason}`,
        });
        restockedCost += l.cost;
      }
      await updateDoc(
        SaleItem,
        l.si,
        {
          $inc: {
            returnedQuantity: l.quantity,
            returnedBaseQuantity: l.baseQuantity,
            returnedAmount: l.amount,
            returnedCost: input.restock ? l.cost : 0,
          },
        },
        tx
      );
    }

    const ret = await createDoc(
      Return,
      {
        _id: returnId,
        businessId: ctx.businessId,
        shopId: ctx.shopId,
        saleId: sale._id,
        returnNumber,
        totalAmount: amount,
        totalCost: round2(restockedCost),
        restocked: input.restock,
        reason: input.reason,
        refundMethod,
        processedBy: ctx.userId,
      },
      tx
    );
    await createDocs(
      ReturnItem,
      lines.map((l) => ({
        returnId,
        saleItemId: l.si._id,
        productVariantId: l.si.productVariantId,
        variantName: l.si.variantName,
        unit: l.si.unit,
        quantity: l.quantity,
        baseQuantity: l.baseQuantity,
        amount: l.amount,
        cost: l.cost,
      })),
      tx
    );

    const refundNumber = formatNumber('RFD-', await nextSequence(`refund:${ctx.shopId}`, tx));
    const refund = await createDoc(
      Refund,
      { businessId: ctx.businessId, shopId: ctx.shopId, saleId: sale._id, returnId, refundNumber, amount, method: refundMethod, reason: input.reason, processedBy: ctx.userId },
      tx
    );
    if (isCredit) {
      const account = await creditAccountFor(ctx, sale, tx);
      if (account) {
        await createDoc(
          CreditPayment,
          { businessId: ctx.businessId, shopId: ctx.shopId, creditAccountId: account._id, customerId: sale.customerId, amount, method: 'RETURN_CREDIT', saleId: sale._id, returnId, note: `Return ${returnNumber}`, recordedBy: ctx.userId },
          tx
        );
        await bumpCreditAccount(tx, account._id, { paid: amount });
      }
    } else {
      await createDoc(
        Payment,
        { businessId: ctx.businessId, shopId: ctx.shopId, kind: 'REFUND', direction: 'OUT', method: refundMethod, amount, saleId: sale._id, refundId: refund._id, recordedBy: ctx.userId },
        tx
      );
    }

    const fresh = await SaleItem.find({ saleId: sale._id }).session(tx.session).lean();
    const allBack = fresh.every((i) => i.returnedQuantity >= i.quantity);
    await updateDoc(
      Sale,
      sale,
      { $inc: { returnedAmount: amount, returnedCost: round2(restockedCost) }, $set: { status: allBack ? 'RETURNED' : 'PARTIALLY_RETURNED' } },
      tx
    );

    await logAudit(
      ctx,
      { category: 'sale', action: 'sale.returned', summary: 'processed return', target: returnNumber, detail: `${sale.receiptNumber} · refund ${naira(amount)}`, entityType: 'Sale', entityId: sale._id },
      tx
    );
    return { id: String(ret._id), returnNumber, refundNumber, amount };
  });
}

/** Refunds money without taking goods back (e.g. an overcharge). Stock is unchanged. */
export async function processRefund(ctx, saleId, input) {
  const sale = await loadSale(ctx, saleId);
  if (sale.status === 'VOIDED') throw ApiError.conflict('This sale was voided.');
  const remaining = netOf(sale);
  if (input.amount > remaining + 0.001) throw ApiError.badRequest(`Refund can’t be more than ${naira(remaining)}.`);
  const isCredit = sale.paymentMethod === 'CREDIT';
  const method = isCredit ? 'CREDIT' : input.method;

  return runAtomic(async (tx) => {
    const fresh = await Sale.findById(sale._id).session(tx.session).lean();
    if (input.amount > netOf(fresh) + 0.001) throw ApiError.conflict('This sale has already changed. Refresh and try again.');
    const refundNumber = formatNumber('RFD-', await nextSequence(`refund:${ctx.shopId}`, tx));
    const refund = await createDoc(
      Refund,
      { businessId: ctx.businessId, shopId: ctx.shopId, saleId: sale._id, refundNumber, amount: input.amount, method, reason: input.reason, processedBy: ctx.userId },
      tx
    );
    if (isCredit) {
      const account = await creditAccountFor(ctx, sale, tx);
      if (account) {
        await createDoc(
          CreditPayment,
          { businessId: ctx.businessId, shopId: ctx.shopId, creditAccountId: account._id, customerId: sale.customerId, amount: input.amount, method: 'RETURN_CREDIT', saleId: sale._id, note: `Refund ${refundNumber}`, recordedBy: ctx.userId },
          tx
        );
        await bumpCreditAccount(tx, account._id, { paid: input.amount });
      }
    } else {
      await createDoc(
        Payment,
        { businessId: ctx.businessId, shopId: ctx.shopId, kind: 'REFUND', direction: 'OUT', method, amount: input.amount, saleId: sale._id, refundId: refund._id, recordedBy: ctx.userId },
        tx
      );
    }
    const fullyRefunded = remaining - input.amount <= 0.001;
    await updateDoc(
      Sale,
      sale,
      { $inc: { refundedAmount: input.amount }, ...(fullyRefunded && sale.status === 'COMPLETED' ? { $set: { status: 'REFUNDED' } } : {}) },
      tx
    );
    await logAudit(
      ctx,
      { category: 'sale', action: 'sale.refunded', summary: 'processed refund', target: refundNumber, detail: `${sale.receiptNumber} · ${naira(input.amount)}`, entityType: 'Sale', entityId: sale._id },
      tx
    );
    return { id: String(refund._id), refundNumber };
  });
}

/** Cancels a sale that has no returns or refunds. Stock goes back; the sale stays in history as VOIDED. */
export async function voidSale(ctx, saleId, { reason }) {
  const sale = await loadSale(ctx, saleId);
  if (sale.status !== 'COMPLETED' || sale.returnedAmount > 0 || sale.refundedAmount > 0) {
    throw ApiError.conflict('Only sales without returns or refunds can be voided. Process a return instead.');
  }
  const items = await SaleItem.find({ saleId: sale._id }).lean();

  return runAtomic(async (tx) => {
    const fresh = await Sale.findById(sale._id).session(tx.session).lean();
    if (fresh.status !== 'COMPLETED') throw ApiError.conflict('This sale has already changed. Refresh and try again.');
    for (const i of items) {
      const variant = await ProductVariant.findById(i.productVariantId).session(tx.session).lean();
      await applyMovement(ctx, tx, {
        variant,
        delta: i.baseQuantity,
        type: 'SALE_VOID',
        restockTotal: i.lineCost,
        ref: { type: 'Sale', id: sale._id, number: sale.receiptNumber },
        reason: `Sale voided: ${reason}`,
      });
    }
    await SaleItem.updateMany({ saleId: sale._id }, { $set: { voided: true } }, { session: tx.session });
    tx.undo(() => SaleItem.updateMany({ saleId: sale._id }, { $set: { voided: false } }));

    if (sale.paymentMethod === 'CREDIT') {
      const account = await creditAccountFor(ctx, sale, tx);
      if (account) await bumpCreditAccount(tx, account._id, { credit: -sale.total });
    } else if (sale.paymentMethod === 'PART') {
      // Cancel the amount owed, and hand back what was paid at the till
      const account = await creditAccountFor(ctx, sale, tx);
      if (account) await bumpCreditAccount(tx, account._id, { credit: -sale.total, paid: -sale.amountPaid });
      await createDoc(
        Payment,
        { businessId: ctx.businessId, shopId: ctx.shopId, kind: 'REFUND', direction: 'OUT', method: sale.paidWith, amount: sale.amountPaid, saleId: sale._id, recordedBy: ctx.userId },
        tx
      );
    } else {
      await createDoc(
        Payment,
        { businessId: ctx.businessId, shopId: ctx.shopId, kind: 'REFUND', direction: 'OUT', method: sale.paymentMethod, amount: sale.total, saleId: sale._id, recordedBy: ctx.userId },
        tx
      );
    }
    await updateDoc(Sale, sale, { $set: { status: 'VOIDED', voidReason: reason, voidedBy: ctx.userId, voidedAt: new Date() } }, tx);
    await logAudit(
      ctx,
      { category: 'sale', action: 'sale.voided', summary: 'voided sale', target: sale.receiptNumber, detail: reason, entityType: 'Sale', entityId: sale._id },
      tx
    );
    return { id: String(sale._id), status: 'VOIDED' };
  });
}

export async function listReturns(ctx, query) {
  const { page, limit, skip } = pageParams(query);
  const filter = { shopId: ctx.shopId };
  const [items, total] = await Promise.all([
    Return.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('saleId', 'receiptNumber').populate('processedBy', 'name').lean(),
    Return.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) || 1 };
}

export async function listRefunds(ctx, query) {
  const { page, limit, skip } = pageParams(query);
  const filter = { shopId: ctx.shopId };
  const [items, total] = await Promise.all([
    Refund.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('saleId', 'receiptNumber').populate('processedBy', 'name').lean(),
    Refund.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.ceil(total / limit) || 1 };
}
