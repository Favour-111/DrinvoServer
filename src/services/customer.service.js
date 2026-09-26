import mongoose from 'mongoose';
import { CreditAccount, CreditPayment, Customer, Payment, Sale } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { createDoc, runAtomic } from '../utils/atomic.js';
import { escapeRegex } from '../utils/serialize.js';
import { resolveRange } from '../utils/dates.js';
import { logAudit } from './audit.service.js';

const naira = (n) => '₦' + Math.round(n).toLocaleString('en-US');
const balanceOf = (a) => Math.max(0, (a?.totalCredit || 0) - (a?.totalPaid || 0));

function toRow(c, account, stats) {
  return {
    id: String(c._id),
    name: c.name,
    businessName: c.businessName,
    phone: c.phone,
    address: c.address,
    notes: c.notes,
    createdAt: c.createdAt,
    totalCredit: account?.totalCredit || 0,
    totalPaid: account?.totalPaid || 0,
    outstanding: balanceOf(account),
    lastTransactionAt: account?.lastTransactionAt || null,
    purchaseCount: stats?.count || 0,
    totalSpent: stats?.spent || 0,
    lastPurchaseAt: stats?.last || null,
  };
}

export async function listCustomers(ctx, { q } = {}) {
  const filter = { shopId: ctx.shopId };
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: re }, { phone: re }, { businessName: re }];
  }
  const customers = await Customer.find(filter).sort({ name: 1 }).lean();
  const ids = customers.map((c) => c._id);
  const [accounts, stats] = await Promise.all([
    CreditAccount.find({ shopId: ctx.shopId, customerId: { $in: ids } }).lean(),
    purchaseStats(ctx, ids),
  ]);
  const byCustomer = new Map(accounts.map((a) => [String(a.customerId), a]));
  return customers
    .map((c) => toRow(c, byCustomer.get(String(c._id)), stats.get(String(c._id))))
    .sort((a, b) => new Date(b.lastPurchaseAt || 0) - new Date(a.lastPurchaseAt || 0) || a.name.localeCompare(b.name));
}

/** Number of purchases, net amount spent and last purchase date per customer. */
async function purchaseStats(ctx, customerIds) {
  const rows = await Sale.aggregate([
    { $match: { shopId: ctx.shopId, customerId: { $in: customerIds }, status: { $ne: 'VOIDED' } } },
    {
      $group: {
        _id: '$customerId',
        count: { $sum: 1 },
        spent: { $sum: { $subtract: ['$total', { $add: ['$returnedAmount', '$refundedAmount'] }] } },
        last: { $max: '$createdAt' },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

export async function createCustomer(ctx, input) {
  const exists = await Customer.findOne({ shopId: ctx.shopId, phone: input.phone }).lean();
  if (exists) throw ApiError.conflict(`${exists.name} already uses this phone number.`, { customerId: String(exists._id) });
  const customer = await Customer.create({ ...input, businessId: ctx.businessId, shopId: ctx.shopId });
  await logAudit(ctx, { category: 'credit', action: 'customer.created', summary: 'added customer', target: customer.name, entityType: 'Customer', entityId: customer._id });
  return toRow(customer.toObject(), null);
}

export async function updateCustomer(ctx, id, input) {
  const customer = await Customer.findOneAndUpdate({ _id: id, shopId: ctx.shopId }, { $set: input }, { new: true, runValidators: true }).lean();
  if (!customer) throw ApiError.notFound('Customer not found.');
  const account = await CreditAccount.findOne({ shopId: ctx.shopId, customerId: customer._id }).lean();
  return toRow(customer, account);
}

export async function getCustomer(ctx, id) {
  const customer = await Customer.findOne({ _id: id, shopId: ctx.shopId }).lean();
  if (!customer) throw ApiError.notFound('Customer not found.');
  const [account, sales, payments] = await Promise.all([
    CreditAccount.findOne({ shopId: ctx.shopId, customerId: customer._id }).lean(),
    Sale.find({ shopId: ctx.shopId, customerId: customer._id }).sort({ createdAt: -1 }).populate('staffId', 'name').lean(),
    CreditPayment.find({ shopId: ctx.shopId, customerId: customer._id }).sort({ createdAt: -1 }).populate('recordedBy', 'name').lean(),
  ]);

  // A voided part-payment sale hands back the upfront payment, so hide that payment too
  const voided = new Set(sales.filter((s) => s.status === 'VOIDED').map((s) => String(s._id)));
  const ledger = [
    ...sales
      .filter((s) => s.paymentMethod === 'CREDIT' || s.paymentMethod === 'PART')
      .map((s) => ({
        type: 'CREDIT_SALE',
        paymentMethod: s.paymentMethod,
        id: String(s._id),
        reference: s.receiptNumber,
        saleId: String(s._id),
        amount: s.status === 'VOIDED' ? 0 : s.total,
        status: s.status,
        date: s.createdAt,
        by: s.staffId?.name,
      })),
    ...payments.filter((p) => !(p.saleId && voided.has(String(p.saleId)) && p.method !== 'RETURN_CREDIT')).map((p) => ({
      type: p.method === 'RETURN_CREDIT' ? 'RETURN_CREDIT' : 'PAYMENT',
      id: String(p._id),
      reference: p.note || '',
      method: p.method,
      saleId: p.saleId ? String(p.saleId) : null,
      amount: p.amount,
      date: p.createdAt,
      by: p.recordedBy?.name,
    })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  const stats = await purchaseStats(ctx, [customer._id]);
  return {
    customer: toRow(customer, account, stats.get(String(customer._id))),
    ledger,
    sales: sales.map((s) => ({
      id: String(s._id),
      receiptNumber: s.receiptNumber,
      total: s.total,
      netTotal: s.status === 'VOIDED' ? 0 : s.total - s.returnedAmount - s.refundedAmount,
      itemCount: s.itemCount,
      paymentMethod: s.paymentMethod,
      status: s.status,
      createdAt: s.createdAt,
      staff: s.staffId?.name || null,
    })),
  };
}

/** Finds the buyer by id or phone, creating them if new. */
export async function resolveCustomer(ctx, tx, { customerId, customer }) {
  let doc;
  if (customerId) {
    doc = await Customer.findOne({ _id: customerId, shopId: ctx.shopId }).session(tx.session).lean();
    if (!doc) throw ApiError.badRequest('Customer not found.');
  } else {
    doc = await Customer.findOne({ shopId: ctx.shopId, phone: customer.phone }).session(tx.session).lean();
    if (!doc) {
      doc = (await createDoc(Customer, { businessId: ctx.businessId, shopId: ctx.shopId, name: customer.name, phone: customer.phone }, tx)).toObject();
      await logAudit(ctx, { category: 'credit', action: 'customer.created', summary: 'added customer', target: doc.name, entityType: 'Customer', entityId: doc._id }, tx);
    }
  }
  return doc;
}

/** Finds or creates the buyer and their credit account. Returns { customer, account }. */
export async function resolveCreditCustomer(ctx, tx, input) {
  const doc = await resolveCustomer(ctx, tx, input);
  let account = await CreditAccount.findOne({ shopId: ctx.shopId, customerId: doc._id }).session(tx.session);
  if (!account) {
    account = await createDoc(CreditAccount, { businessId: ctx.businessId, shopId: ctx.shopId, customerId: doc._id }, tx);
  }
  return { customer: doc, account };
}

/** Adjusts a credit account's running totals within a transaction. */
export async function bumpCreditAccount(tx, accountId, { credit = 0, paid = 0 }) {
  const updated = await CreditAccount.findOneAndUpdate(
    { _id: accountId },
    { $inc: { totalCredit: credit, totalPaid: paid }, $set: { lastTransactionAt: new Date() } },
    { new: true, session: tx.session }
  );
  tx.undo(() => CreditAccount.updateOne({ _id: accountId }, { $inc: { totalCredit: -credit, totalPaid: -paid } }));
  return updated;
}

export async function recordCreditPayment(ctx, { customerId, amount, method, note }) {
  const customer = await Customer.findOne({ _id: customerId, shopId: ctx.shopId }).lean();
  if (!customer) throw ApiError.notFound('Customer not found.');
  const account = await CreditAccount.findOne({ shopId: ctx.shopId, customerId }).lean();
  const outstanding = balanceOf(account);
  if (!account || outstanding <= 0) throw ApiError.badRequest(`${customer.name} does not owe anything.`);
  if (amount > outstanding) throw ApiError.badRequest(`That is more than the ${naira(outstanding)} owed.`);

  return runAtomic(async (tx) => {
    const paymentId = new mongoose.Types.ObjectId();
    await createDoc(
      CreditPayment,
      { _id: paymentId, businessId: ctx.businessId, shopId: ctx.shopId, creditAccountId: account._id, customerId, amount, method, note, recordedBy: ctx.userId },
      tx
    );
    await createDoc(
      Payment,
      { businessId: ctx.businessId, shopId: ctx.shopId, kind: 'CREDIT_PAYMENT', direction: 'IN', method, amount, creditPaymentId: paymentId, customerId, recordedBy: ctx.userId },
      tx
    );
    const updated = await bumpCreditAccount(tx, account._id, { paid: amount });
    await logAudit(
      ctx,
      { category: 'credit', action: 'credit.payment', summary: 'recorded payment', target: customer.name, detail: `${naira(amount)} · ${method}`, entityType: 'Customer', entityId: customer._id },
      tx
    );
    return { outstanding: balanceOf(updated) };
  });
}

export async function creditSummary(ctx) {
  const accounts = await CreditAccount.find({ shopId: ctx.shopId }).lean();
  const monthStart = resolveRange({ range: 'month' }, ctx.business.timezone).start;
  const [collected] = await CreditPayment.aggregate([
    { $match: { shopId: ctx.shopId, method: { $ne: 'RETURN_CREDIT' }, createdAt: { $gte: monthStart } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return {
    outstanding: accounts.reduce((s, a) => s + balanceOf(a), 0),
    customersOwing: accounts.filter((a) => balanceOf(a) > 0).length,
    collectedThisMonth: collected?.total || 0,
    customers: await Customer.countDocuments({ shopId: ctx.shopId }),
  };
}

export const creditBalance = balanceOf;
