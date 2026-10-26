import mongoose from 'mongoose';
import { CreditAccount, CreditPayment, Customer, Inventory, OnDemandPurchase, Payment, ProductVariant, Refund, Return, ReturnItem, Sale, SaleItem } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { createDoc, createDocs, runAtomic, updateDoc } from '../utils/atomic.js';
import { describeStock, minimumFor, packagingOf, priceFor, toBase } from '../utils/units.js';
import { formatNumber, nextSequence } from '../utils/sequence.js';
import { resolveRange } from '../utils/dates.js';
import { escapeRegex, pageParams } from '../utils/serialize.js';
import { can, P } from '../config/roles.js';
import { applyMovement, loadVariant } from './inventory.service.js';
import { bumpCreditAccount, resolveCreditCustomer, resolveCustomer } from './customer.service.js';
import { consumeOnDemandStock } from './ondemand.service.js';
import { logAudit } from './audit.service.js';

const naira = (n) => '₦' + Math.round(n).toLocaleString('en-US');
const METHOD_LABEL = { CASH: 'Cash', POS: 'POS', TRANSFER: 'Transfer', CREDIT: 'Credit', PART: 'Part payment' };

/**
 * Validates the products on a sale and prices every line. With `checkStock`, also gives a friendly
 * up-front stock shortage error (the deduction itself re-checks atomically). Edits skip it because
 * the sale being edited is still holding its own stock until it's reversed inside the transaction.
 */
async function prepareSale(ctx, input, { checkStock }) {
  // 1-2. Validate staff permission (route) and products
  const lines = [];
  const needByVariant = new Map();
  for (const item of input.items) {
    const variant = await loadVariant(ctx, item.variantId);
    // 4. Convert selling unit to base bottles
    const { conversion, baseQuantity } = toBase(variant, item.unit, item.quantity);
    // A staff-entered price is the actual per-unit price to charge — it can go above or below the
    // catalog price, but never below the admin-configured minimum (0 = no floor).
    const listPrice = priceFor(variant, item.unit);
    // A typed line total (e.g. 3 drinks rounded up to ₦11,800) wins over a per-unit price: the unit
    // price is derived from it, and the total is charged exactly as typed.
    const typedTotal = item.lineTotal != null ? Number(item.lineTotal) : null;
    const unitPrice = typedTotal != null ? typedTotal / item.quantity : item.price != null ? Number(item.price) : listPrice;
    if (unitPrice < 0) {
      throw ApiError.badRequest(`Price can’t be negative for ${variant.name}.`, { fields: { items: 'Invalid price' } });
    }
    const minPrice = minimumFor(variant, item.unit);
    if (minPrice > 0 && unitPrice < minPrice) {
      throw ApiError.badRequest(`${variant.name} can’t be sold below its minimum price of ${naira(minPrice)}.`, { fields: { items: 'Price is below the minimum selling price' } });
    }
    // Still tracked for reporting/receipts, but only ever a knocked-off amount — never negative,
    // so selling above the catalog price isn't recorded as a (nonsensical) negative discount.
    const discount = Math.round(Math.max(0, listPrice - unitPrice) * 100) / 100;
    lines.push({ variant, item, conversion, baseQuantity, listPrice, discount, unitPrice, lineTotal: typedTotal != null ? typedTotal : unitPrice * item.quantity });
    needByVariant.set(String(variant._id), (needByVariant.get(String(variant._id)) || 0) + baseQuantity);
  }

  // Logging a past sale: everything it touches (the sale, its stock deduction, its payment)
  // is dated to when it actually happened, not to now, so reports show it on the right day.
  const occurredAt = input.backdatedAt ?? null;
  const dated = occurredAt ? { createdAt: occurredAt, updatedAt: occurredAt } : {};

  // Part payment: some now, the rest on credit. Paying the whole bill is a normal sale.
  const saleTotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const isPart = input.paymentMethod === 'PART';
  if (isPart && input.amountPaid >= saleTotal) {
    throw ApiError.badRequest(`${naira(input.amountPaid)} covers the whole ${naira(saleTotal)}. Choose ${METHOD_LABEL[input.paidWith]} instead of part payment.`, {
      fields: { amountPaid: 'Must be less than the total' },
    });
  }

  // 3. Friendly stock check up front (the deduction below re-checks atomically)
  if (checkStock) {
    const inventories = await Inventory.find({ shopId: ctx.shopId, productVariantId: { $in: [...needByVariant.keys()] } }).lean();
    const shortages = [];
    for (const [variantId, need] of needByVariant) {
      const available = inventories.find((i) => String(i.productVariantId) === variantId)?.quantity || 0;
      if (need > available) {
        const v = lines.find((l) => String(l.variant._id) === variantId).variant;
        shortages.push({ variantId, name: v.name, requested: need, available, availableText: describeStock(v, available) });
      }
    }
    if (shortages.length) {
      throw ApiError.conflict(
        shortages.length === 1
          ? `Not enough stock available for ${shortages[0].name}. Only ${shortages[0].availableText} left.`
          : 'Not enough stock available for some items.',
        { shortages }
      );
    }
  }

  return { lines, occurredAt, dated, isPart };
}

/** Writes a sale's items, stock movements, payments and credit within `tx`. Shared by createSale and editSale. */
async function writeSale(ctx, tx, input, { lines, occurredAt, dated, isPart, saleId, receiptNumber, existing = null }) {
  // Every sale records who bought it; credit sales also need a credit account
  let credit = null;
  let buyer = null;
  if (input.paymentMethod === 'CREDIT' || isPart) {
    credit = await resolveCreditCustomer(ctx, tx, { customerId: input.customerId, customer: input.customer });
    buyer = credit.customer;
  } else if (input.customerId || input.customer) {
    buyer = await resolveCustomer(ctx, tx, { customerId: input.customerId, customer: input.customer });
  }

  // 10-11. Deduct stock and write movements; 6. cost comes from the average before this sale
  const itemDocs = [];
  for (const l of lines) {
    const { unitCost } = await applyMovement(ctx, tx, {
      variant: l.variant,
      delta: -l.baseQuantity,
      type: 'SALE',
      ref: { type: 'Sale', id: saleId, number: receiptNumber },
      reason: 'Sale',
      date: occurredAt,
    });
    // Bookkeeping only — links this sale to whichever on-demand purchase batch(es) it drew
    // from so each stays correctly marked sold/partially sold for audit purposes. The stock
    // deduction and its cost already happened above, the same as for any other sale.
    await consumeOnDemandStock(ctx, tx, l.variant._id, l.baseQuantity, { id: saleId, number: receiptNumber });
    itemDocs.push({
      saleId,
      businessId: ctx.businessId,
      shopId: ctx.shopId,
      productId: l.variant.productId,
      productVariantId: l.variant._id,
      productName: l.variant.product.name,
      variantName: l.variant.name,
      category: l.variant.product.category,
      packagingType: packagingOf(l.variant),
      unit: l.item.unit,
      quantity: l.item.quantity,
      conversion: l.conversion,
      baseQuantity: l.baseQuantity,
      listPrice: l.listPrice,
      discount: l.discount,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
      unitCost,
      lineCost: Math.round(unitCost * l.baseQuantity * 100) / 100,
      ...dated,
    });
  }

  // 5, 7. Totals and profit
  const total = itemDocs.reduce((s, i) => s + i.lineTotal, 0);
  const totalCost = Math.round(itemDocs.reduce((s, i) => s + i.lineCost, 0) * 100) / 100;
  const totalDiscount = Math.round(itemDocs.reduce((s, i) => s + i.discount * i.quantity, 0) * 100) / 100;

  // 8-9. Sale and items
  const figures = {
    customerId: buyer?._id ?? null,
    itemCount: itemDocs.length,
    total,
    totalCost,
    totalDiscount,
    paymentMethod: input.paymentMethod,
    amountPaid: isPart ? input.amountPaid : input.paymentMethod === 'CREDIT' ? 0 : total,
    paidWith: isPart ? input.paidWith : null,
  };
  // An edit rewrites the existing sale in place (same id, receipt number and staff); a new sale is created.
  const sale = existing
    ? await updateDoc(Sale, existing, { $set: { ...figures, ...(occurredAt ? { createdAt: occurredAt } : {}) } }, tx)
    : await createDoc(
        Sale,
        {
          _id: saleId,
          businessId: ctx.businessId,
          shopId: ctx.shopId,
          receiptNumber,
          ...(input.clientTransactionId ? { clientTransactionId: input.clientTransactionId } : {}),
          staffId: ctx.userId,
          ...figures,
          ...dated,
        },
        tx
      );
  await createDocs(SaleItem, itemDocs, tx);

  // 12. Payment records (Drinvo records the method; it never moves money).
  // A part payment is two records: the money taken now, and the amount put on credit.
  const payment = (method, amount) =>
    createDoc(Payment, { businessId: ctx.businessId, shopId: ctx.shopId, kind: 'SALE', direction: 'IN', method, amount, saleId, customerId: buyer?._id ?? null, recordedBy: ctx.userId, ...dated }, tx);
  if (isPart) {
    await payment(input.paidWith, input.amountPaid);
    await payment('CREDIT', total - input.amountPaid);
  } else {
    await payment(input.paymentMethod, total);
  }
  if (credit) {
    await bumpCreditAccount(tx, credit.account._id, { credit: total, paid: isPart ? input.amountPaid : 0 });
    if (isPart) {
      await createDoc(
        CreditPayment,
        {
          businessId: ctx.businessId,
          shopId: ctx.shopId,
          creditAccountId: credit.account._id,
          customerId: buyer._id,
          amount: input.amountPaid,
          method: input.paidWith,
          saleId,
          note: `Paid at sale ${receiptNumber}`,
          recordedBy: ctx.userId,
          ...dated,
        },
        tx
      );
    }
  }

  await logAudit(
    ctx,
    {
      category: 'sale',
      action: existing ? 'sale.edited' : 'sale.completed',
      summary: existing ? 'edited sale' : 'completed sale',
      target: receiptNumber,
      detail: `${naira(total)} · ${isPart ? `${naira(input.amountPaid)} ${METHOD_LABEL[input.paidWith]} now, ${naira(total - input.amountPaid)} owed` : METHOD_LABEL[input.paymentMethod]}${buyer ? ` · ${buyer.name}` : ''}${totalDiscount > 0 ? ` · ${naira(totalDiscount)} discount` : ''}${occurredAt ? ` · backdated to ${occurredAt.toDateString()}` : ''}`,
      entityType: 'Sale',
      entityId: saleId,
    },
    tx
  );
  return { id: String(sale._id), receiptNumber };
}

/**
 * Completes a sale in one atomic write:
 * validate products and stock, convert units to bottles, price the sale,
 * take cost from the shop's weighted average, create the sale and its items,
 * deduct stock with movements, record the payment, and number the receipt.
 */
export async function createSale(ctx, input) {
  // Idempotency: an offline client may retry the same sale after a dropped response.
  // If we've already recorded this clientTransactionId for this shop, hand back that sale
  // instead of creating a second one.
  if (input.clientTransactionId) {
    const existing = await Sale.findOne({ shopId: ctx.shopId, clientTransactionId: input.clientTransactionId }).lean();
    if (existing) return { id: String(existing._id), receiptNumber: existing.receiptNumber, alreadyProcessed: true };
  }

  const { lines, occurredAt, dated, isPart } = await prepareSale(ctx, input, { checkStock: true });

  try {
    return await runAtomic(async (tx) => {
      // 13. Receipt number
      const seq = await nextSequence(`receipt:${ctx.shopId}`, tx);
      const receiptNumber = formatNumber(ctx.business.receiptPrefix || 'INV-', seq);
      return writeSale(ctx, tx, input, { lines, occurredAt, dated, isPart, saleId: new mongoose.Types.ObjectId(), receiptNumber });
    });
  } catch (err) {
    // Two concurrent retries of the same offline sale can both pass the check above; the
    // sparse unique index on (shopId, clientTransactionId) rejects the second insert, and we
    // treat that exactly like a normal idempotent replay instead of surfacing a 500.
    if (input.clientTransactionId && err?.code === 11000) {
      const existing = await Sale.findOne({ shopId: ctx.shopId, clientTransactionId: input.clientTransactionId }).lean();
      if (existing) return { id: String(existing._id), receiptNumber: existing.receiptNumber, alreadyProcessed: true };
    }
    throw err;
  }
}

/**
 * Edits a completed sale and recalculates everything that came from it. The old sale is reversed
 * (stock back with its original cost, payments and credit undone, on-demand links released) and
 * the new details are written through the same path as a new sale, so totals, cost, profit,
 * payments, credit balances and stock all end up exactly as if it had been rung up this way.
 * The receipt number, staff and date are kept unless a new date is given.
 */
export async function editSale(ctx, saleId, input) {
  const sale = await Sale.findOne({ _id: saleId, shopId: ctx.shopId });
  if (!sale) throw ApiError.notFound('Sale not found.');
  if (sale.status !== 'COMPLETED' || sale.returnedAmount > 0 || sale.refundedAmount > 0) {
    throw ApiError.conflict('Only sales without returns or refunds can be edited. Process a return instead.');
  }

  const { lines, isPart } = await prepareSale(ctx, input, { checkStock: false });
  const occurredAt = input.backdatedAt ?? sale.createdAt;
  const dated = { createdAt: occurredAt, updatedAt: occurredAt };
  const oldItems = await SaleItem.find({ saleId: sale._id }).lean();

  return runAtomic(async (tx) => {
    const fresh = await Sale.findById(sale._id).session(tx.session).lean();
    if (fresh.status !== 'COMPLETED' || fresh.total !== sale.total) throw ApiError.conflict('This sale has already changed. Refresh and try again.');

    // Put the old stock back at the cost it was taken at
    for (const i of oldItems) {
      const variant = await ProductVariant.findById(i.productVariantId).session(tx.session).lean();
      await applyMovement(ctx, tx, {
        variant,
        delta: i.baseQuantity,
        type: 'SALE_VOID',
        restockTotal: i.lineCost,
        ref: { type: 'Sale', id: sale._id, number: sale.receiptNumber },
        reason: 'Sale edited',
        date: occurredAt,
      });
    }

    // Release on-demand batches this sale had drawn from
    const batches = await OnDemandPurchase.find({ shopId: ctx.shopId, 'saleLinks.saleId': sale._id }).session(tx.session).lean();
    for (const b of batches) {
      const back = b.saleLinks.filter((l) => String(l.saleId) === String(sale._id)).reduce((n, l) => n + l.baseQuantity, 0);
      const remaining = b.remainingBaseQuantity + back;
      await OnDemandPurchase.updateOne(
        { _id: b._id },
        { $set: { remainingBaseQuantity: remaining, status: remaining >= b.baseQuantity ? 'PURCHASED' : 'PARTIALLY_SOLD', saleLinks: b.saleLinks.filter((l) => String(l.saleId) !== String(sale._id)) } },
        { session: tx.session }
      );
      tx.undo(() => OnDemandPurchase.updateOne({ _id: b._id }, { $set: { remainingBaseQuantity: b.remainingBaseQuantity, status: b.status, saleLinks: b.saleLinks } }));
    }

    // Undo the old credit, then drop the old items and payment records
    if (sale.paymentMethod === 'CREDIT' || sale.paymentMethod === 'PART') {
      const account = sale.customerId ? await CreditAccount.findOne({ shopId: ctx.shopId, customerId: sale.customerId }).session(tx.session) : null;
      if (account) await bumpCreditAccount(tx, account._id, { credit: -sale.total, paid: sale.paymentMethod === 'PART' ? -sale.amountPaid : 0 });
    }
    for (const [Model, filter] of [
      [SaleItem, { saleId: sale._id }],
      [Payment, { saleId: sale._id, kind: 'SALE' }],
      [CreditPayment, { saleId: sale._id }],
    ]) {
      const old = await Model.find(filter).session(tx.session).lean();
      await Model.deleteMany(filter, { session: tx.session });
      tx.undo(() => (old.length ? Model.collection.insertMany(old) : null));
    }

    const result = await writeSale(ctx, tx, input, { lines, occurredAt, dated, isPart, saleId: sale._id, receiptNumber: sale.receiptNumber, existing: sale });
    // Mongoose never lets createdAt change through an update, so move the date directly
    await Sale.collection.updateOne({ _id: sale._id }, { $set: { createdAt: occurredAt } }, { session: tx.session });
    tx.undo(() => Sale.collection.updateOne({ _id: sale._id }, { $set: { createdAt: sale.createdAt } }));
    return result;
  });
}

/**
 * Batch entry point for offline-first staff clients: processes each queued local sale through
 * the same createSale() path (same validation, atomicity and idempotency), and reports which
 * ones landed and which need attention, instead of failing the whole batch on one bad item.
 */
export async function syncSales(ctx, { sales }) {
  const successful = [];
  const failed = [];
  for (const item of sales) {
    try {
      const result = await createSale(ctx, item);
      const variantIds = [...new Set(item.items.map((i) => i.variantId))];
      const inventory = await Inventory.find({ shopId: ctx.shopId, productVariantId: { $in: variantIds } }, 'productVariantId quantity').lean();
      successful.push({
        clientTransactionId: item.clientTransactionId,
        serverTransactionId: result.id,
        receiptNumber: result.receiptNumber,
        status: 'SYNCED',
        inventoryUpdates: inventory.map((i) => ({ productVariantId: String(i.productVariantId), quantity: i.quantity })),
      });
    } catch (err) {
      failed.push({ id: item.clientTransactionId, reason: err.message || 'Could not process this sale.' });
    }
  }
  return { successful, failed };
}

const round2 = (n) => Math.round(n * 100) / 100;

function saleView(s, items = []) {
  const netTotal = s.status === 'VOIDED' ? 0 : round2(s.total - s.returnedAmount - s.refundedAmount);
  const netCost = s.status === 'VOIDED' ? 0 : round2(s.totalCost - s.returnedCost);
  return {
    id: String(s._id),
    receiptNumber: s.receiptNumber,
    status: s.status,
    paymentMethod: s.paymentMethod,
    paidWith: s.paidWith || null,
    // Older sales have no amountPaid; infer it from the method
    amountPaid: s.amountPaid ?? (s.paymentMethod === 'CREDIT' ? 0 : s.total),
    balanceAtSale: s.paymentMethod === 'CREDIT' ? s.total : s.paymentMethod === 'PART' ? round2(s.total - s.amountPaid) : 0,
    total: s.total,
    totalCost: s.totalCost,
    totalDiscount: s.totalDiscount || 0,
    returnedAmount: s.returnedAmount,
    returnedCost: s.returnedCost,
    refundedAmount: s.refundedAmount,
    netTotal,
    netCost,
    profit: round2(netTotal - netCost),
    itemCount: s.itemCount,
    createdAt: s.createdAt,
    voidReason: s.voidReason,
    voidedAt: s.voidedAt,
    staff: s.staffId?._id ? { id: String(s.staffId._id), name: s.staffId.name, color: s.staffId.color } : null,
    customer: s.customerId?._id ? { id: String(s.customerId._id), name: s.customerId.name, phone: s.customerId.phone } : null,
    items: items.map((i) => ({
      id: String(i._id),
      variantId: String(i.productVariantId),
      productId: String(i.productId),
      productName: i.productName,
      variantName: i.variantName,
      category: i.category,
      packagingType: i.packagingType || 'STANDARD',
      unit: i.unit,
      quantity: i.quantity,
      conversion: i.conversion,
      baseQuantity: i.baseQuantity,
      listPrice: i.listPrice ?? i.unitPrice,
      discount: i.discount ?? Math.max(0, (i.listPrice ?? i.unitPrice) - i.unitPrice),
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
      unitCost: i.unitCost,
      lineCost: i.lineCost,
      returnedQuantity: i.returnedQuantity,
      returnedAmount: i.returnedAmount,
    })),
  };
}

export async function listSales(ctx, query) {
  const { page, limit, skip } = pageParams(query);
  const filter = { shopId: ctx.shopId };
  // Staff only ever see their own sales
  if (!can(ctx.user, P.SALE_READ_ALL)) filter.staffId = ctx.userId;
  else if (query.staffId) filter.staffId = new mongoose.Types.ObjectId(query.staffId);
  if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;
  if (query.status) filter.status = { $in: query.status.split(',') };
  if (query.customerId) filter.customerId = new mongoose.Types.ObjectId(query.customerId);
  if (query.range && query.range !== 'all') {
    const r = resolveRange(query, ctx.business.timezone);
    filter.createdAt = { $gte: r.start, $lt: r.end };
  }
  if (query.q) {
    const re = new RegExp(escapeRegex(query.q), 'i');
    const [itemSaleIds, customerIds] = await Promise.all([
      SaleItem.distinct('saleId', { shopId: ctx.shopId, variantName: re }),
      Customer.distinct('_id', { shopId: ctx.shopId, $or: [{ name: re }, { phone: re }] }),
    ]);
    filter.$or = [{ receiptNumber: re }, { _id: { $in: itemSaleIds } }, { customerId: { $in: customerIds } }];
  }

  // One round trip for the page of sales (with staff, customer and lines joined in) and one for totals, in parallel
  const [sales, totals] = await Promise.all([
    Sale.aggregate([
      { $match: filter },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      { $lookup: { from: 'users', localField: 'staffId', foreignField: '_id', as: 'staff', pipeline: [{ $project: { name: 1, color: 1 } }] } },
      { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', as: 'customer', pipeline: [{ $project: { name: 1, phone: 1 } }] } },
      { $lookup: { from: 'saleitems', localField: '_id', foreignField: 'saleId', as: 'lines' } },
    ]),
    Sale.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          revenue: { $sum: { $cond: [{ $eq: ['$status', 'VOIDED'] }, 0, { $subtract: ['$total', { $add: ['$returnedAmount', '$refundedAmount'] }] }] } },
          cost: { $sum: { $cond: [{ $eq: ['$status', 'VOIDED'] }, 0, { $subtract: ['$totalCost', '$returnedCost'] }] } },
        },
      },
    ]),
  ]);
  const t = totals[0] || { count: 0, revenue: 0, cost: 0 };
  const total = t.count;
  return {
    items: sales.map((s) => saleView({ ...s, staffId: s.staff[0] || null, customerId: s.customer[0] || null }, s.lines)),
    total,
    page,
    pages: Math.ceil(total / limit) || 1,
    totals: { count: t.count, revenue: t.revenue, cost: t.cost, profit: t.revenue - t.cost },
  };
}

export async function getSale(ctx, id) {
  const sale = await Sale.findOne({ _id: id, shopId: ctx.shopId }).populate('staffId', 'name color').populate('customerId', 'name phone').lean();
  if (!sale) throw ApiError.notFound('Sale not found.');
  if (!can(ctx.user, P.SALE_READ_ALL) && String(sale.staffId?._id) !== String(ctx.userId)) {
    throw ApiError.notFound('Sale not found.');
  }
  const [items, returns, refunds] = await Promise.all([
    SaleItem.find({ saleId: sale._id }).lean(),
    Return.find({ saleId: sale._id }).sort({ createdAt: 1 }).populate('processedBy', 'name').lean(),
    Refund.find({ saleId: sale._id }).sort({ createdAt: 1 }).populate('processedBy', 'name').lean(),
  ]);
  const returnItems = await ReturnItem.find({ returnId: { $in: returns.map((r) => r._id) } }).lean();
  return {
    ...saleView(sale, items),
    returns: returns.map((r) => ({
      id: String(r._id),
      returnNumber: r.returnNumber,
      totalAmount: r.totalAmount,
      restocked: r.restocked,
      reason: r.reason,
      refundMethod: r.refundMethod,
      createdAt: r.createdAt,
      processedBy: r.processedBy?.name,
      items: returnItems
        .filter((i) => String(i.returnId) === String(r._id))
        .map((i) => ({ saleItemId: String(i.saleItemId), variantName: i.variantName, unit: i.unit, quantity: i.quantity, amount: i.amount })),
    })),
    refunds: refunds.map((r) => ({
      id: String(r._id),
      refundNumber: r.refundNumber,
      amount: r.amount,
      method: r.method,
      reason: r.reason,
      returnId: r.returnId ? String(r.returnId) : null,
      createdAt: r.createdAt,
      processedBy: r.processedBy?.name,
    })),
  };
}
