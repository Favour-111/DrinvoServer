import { CreditAccount, CreditPayment, InventoryMovement, ProductVariant, Refund, Return, Sale, SaleItem } from '../models/index.js';
import { MOVEMENT_TYPES } from '../config/constants.js';
import { resolveRange } from '../utils/dates.js';
import { stockRows, summarize } from './inventory.service.js';
import { creditBalance } from './customer.service.js';

const round2 = (n) => Math.round((n || 0) * 100) / 100;
const notVoided = { $ne: ['$status', 'VOIDED'] };
const NET_REVENUE = { $cond: [notVoided, { $subtract: ['$total', { $add: ['$returnedAmount', '$refundedAmount'] }] }, 0] };
const NET_COST = { $cond: [notVoided, { $subtract: ['$totalCost', '$returnedCost'] }, 0] };

async function saleTotals(ctx, start, end, extra = {}) {
  const [[t], [u]] = await Promise.all([
    Sale.aggregate([
    { $match: { shopId: ctx.shopId, createdAt: { $gte: start, $lt: end }, ...extra } },
    {
      $group: {
        _id: null,
        revenue: { $sum: NET_REVENUE },
        cost: { $sum: NET_COST },
        transactions: { $sum: { $cond: [notVoided, 1, 0] } },
      },
    },
  ]),
    SaleItem.aggregate([
      { $match: { shopId: ctx.shopId, createdAt: { $gte: start, $lt: end }, voided: false } },
      { $group: { _id: null, units: { $sum: { $subtract: ['$baseQuantity', '$returnedBaseQuantity'] } } } },
    ]),
  ]);
  const revenue = round2(t?.revenue);
  const cost = round2(t?.cost);
  const transactions = t?.transactions || 0;
  return {
    revenue,
    cost,
    grossProfit: round2(revenue - cost),
    margin: revenue ? round2(((revenue - cost) / revenue) * 100) : 0,
    transactions,
    unitsSold: u?.units || 0,
    averageSale: transactions ? round2(revenue / transactions) : 0,
  };
}

async function series(ctx, r) {
  const format = r.granularity === 'hour' ? '%H' : '%Y-%m-%d';
  const rows = await Sale.aggregate([
    { $match: { shopId: ctx.shopId, createdAt: { $gte: r.start, $lt: r.end } } },
    {
      $group: {
        _id: { $dateToString: { format, date: '$createdAt', timezone: r.timeZone } },
        revenue: { $sum: NET_REVENUE },
        cost: { $sum: NET_COST },
        transactions: { $sum: { $cond: [notVoided, 1, 0] } },
      },
    },
  ]);
  const byKey = new Map(rows.map((x) => [x._id, x]));
  return r.buckets.map((key) => {
    const x = byKey.get(key);
    const revenue = round2(x?.revenue);
    const cost = round2(x?.cost);
    return { key, revenue, cost, profit: round2(revenue - cost), transactions: x?.transactions || 0 };
  });
}

async function productProfitability(ctx, start, end) {
  const rows = await SaleItem.aggregate([
    { $match: { shopId: ctx.shopId, createdAt: { $gte: start, $lt: end }, voided: false } },
    {
      $group: {
        _id: '$productVariantId',
        name: { $last: '$variantName' },
        productId: { $last: '$productId' },
        category: { $last: '$category' },
        unitsSold: { $sum: { $subtract: ['$baseQuantity', '$returnedBaseQuantity'] } },
        revenue: { $sum: { $subtract: ['$lineTotal', '$returnedAmount'] } },
        cost: { $sum: { $subtract: ['$lineCost', '$returnedCost'] } },
      },
    },
    { $sort: { revenue: -1 } },
  ]);
  return rows.map((r) => {
    const revenue = round2(r.revenue);
    const cost = round2(r.cost);
    return {
      variantId: String(r._id),
      productId: String(r.productId),
      name: r.name,
      category: r.category,
      unitsSold: r.unitsSold,
      revenue,
      cost,
      profit: round2(revenue - cost),
      margin: revenue ? round2(((revenue - cost) / revenue) * 100) : 0,
    };
  });
}

function categoryShare(products) {
  const total = products.reduce((s, p) => s + p.revenue, 0);
  const map = new Map();
  for (const p of products) map.set(p.category || 'Other', (map.get(p.category || 'Other') || 0) + p.revenue);
  return [...map.entries()]
    .map(([category, revenue]) => ({ category, revenue: round2(revenue), share: total ? round2((revenue / total) * 100) : 0 }))
    .sort((a, b) => b.revenue - a.revenue);
}

/** Money actually taken in within [start, end), including part/credit payments collected
 * today against sales made on earlier days — distinct from `saleTotals().revenue`, which
 * books a credit sale's full amount on the day the sale happened, not when it's paid off. */
async function creditCollected(ctx, start, end) {
  const [row] = await CreditPayment.aggregate([
    { $match: { shopId: ctx.shopId, method: { $ne: 'RETURN_CREDIT' }, createdAt: { $gte: start, $lt: end } } },
    { $group: { _id: null, amount: { $sum: '$amount' } } },
  ]);
  return round2(row?.amount);
}

async function creditOutstanding(ctx) {
  const accounts = await CreditAccount.find({ shopId: ctx.shopId }).lean();
  return round2(accounts.reduce((s, a) => s + creditBalance(a), 0));
}

export async function summary(ctx, query) {
  const r = resolveRange(query, ctx.business.timezone);
  const [totals, points, products, returns, refunds, payments, outstanding] = await Promise.all([
    saleTotals(ctx, r.start, r.end),
    series(ctx, r),
    productProfitability(ctx, r.start, r.end),
    Return.countDocuments({ shopId: ctx.shopId, createdAt: { $gte: r.start, $lt: r.end } }),
    Refund.aggregate([
      { $match: { shopId: ctx.shopId, createdAt: { $gte: r.start, $lt: r.end } } },
      { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Sale.aggregate([
      { $match: { shopId: ctx.shopId, createdAt: { $gte: r.start, $lt: r.end }, status: { $ne: 'VOIDED' } } },
      { $group: { _id: '$paymentMethod', amount: { $sum: NET_REVENUE }, count: { $sum: 1 } } },
    ]),
    creditOutstanding(ctx),
  ]);
  const payTotal = payments.reduce((s, p) => s + p.amount, 0);
  return {
    range: { range: r.range, start: r.start, end: r.end, granularity: r.granularity, days: r.granularity === 'day' ? r.buckets.length : 1 },
    totals: {
      ...totals,
      returns,
      refunds: round2(refunds[0]?.amount),
      refundCount: refunds[0]?.count || 0,
      creditOutstanding: outstanding,
    },
    series: points,
    paymentMix: ['CASH', 'POS', 'TRANSFER', 'CREDIT', 'PART'].map((m) => {
      const p = payments.find((x) => x._id === m);
      return { method: m, amount: round2(p?.amount), count: p?.count || 0, share: payTotal ? round2(((p?.amount || 0) / payTotal) * 100) : 0 };
    }),
    products,
    categories: categoryShare(products),
  };
}

/** Only what the dashboard shows: headline numbers, the chart, stock alerts and recent sales. */
export async function dashboard(ctx, query) {
  const tz = ctx.business.timezone;
  const today = resolveRange({ range: 'today' }, tz);
  const yesterday = resolveRange({ range: 'yesterday' }, tz);
  const chartRange = resolveRange(query.range ? query : { range: '7d' }, tz);

  // Everything runs in parallel: one database round trip for the whole page (plus sale lines)
  const [todayTotals, yesterdayTotals, todayCollected, yesterdayCollected, points, chartTotals, rows, recentSales] = await Promise.all([
    saleTotals(ctx, today.start, today.end),
    saleTotals(ctx, yesterday.start, yesterday.end),
    creditCollected(ctx, today.start, today.end),
    creditCollected(ctx, yesterday.start, yesterday.end),
    series(ctx, chartRange),
    saleTotals(ctx, chartRange.start, chartRange.end),
    stockRows(ctx),
    Sale.find({ shopId: ctx.shopId }).sort({ createdAt: -1 }).limit(6).populate('staffId', 'name color').populate('customerId', 'name phone').lean(),
  ]);
  const saleItems = await SaleItem.find({ saleId: { $in: recentSales.map((s) => s._id) } }, 'saleId variantName unit quantity').lean();

  return {
    today: { ...todayTotals, cashCollected: todayCollected },
    yesterday: { ...yesterdayTotals, cashCollected: yesterdayCollected },
    inventory: summarize(rows),
    chart: { range: chartRange.range, granularity: chartRange.granularity, points, totals: chartTotals },
    lowStock: rows.filter((r) => r.status === 'low').sort((a, b) => a.quantity / (a.lowStockThreshold || 1) - b.quantity / (b.lowStockThreshold || 1)),
    outOfStock: rows.filter((r) => r.status === 'out'),
    recentSales: recentSales.map((s) => ({
      id: String(s._id),
      receiptNumber: s.receiptNumber,
      total: s.total,
      paymentMethod: s.paymentMethod,
      status: s.status,
      createdAt: s.createdAt,
      staff: s.staffId ? { id: String(s.staffId._id), name: s.staffId.name } : null,
      customer: s.customerId ? { id: String(s.customerId._id), name: s.customerId.name, phone: s.customerId.phone } : null,
      items: saleItems.filter((i) => String(i.saleId) === String(s._id)).map((i) => ({ variantName: i.variantName, unit: i.unit, quantity: i.quantity })),
    })),
  };
}

/** A staff member's own figures. Never includes cost or business totals. */
export async function myStats(ctx) {
  const tz = ctx.business.timezone;
  const today = resolveRange({ range: 'today' }, tz);
  const yesterday = resolveRange({ range: 'yesterday' }, tz);
  const month = resolveRange({ range: 'month' }, tz);
  const mine = { staffId: ctx.userId };
  const [t, y, m] = await Promise.all([
    saleTotals(ctx, today.start, today.end, mine),
    saleTotals(ctx, yesterday.start, yesterday.end, mine),
    saleTotals(ctx, month.start, month.end, mine),
  ]);
  return {
    todaySales: t.revenue,
    todayTransactions: t.transactions,
    todayAverage: t.averageSale,
    yesterdaySales: y.revenue,
    yesterdayTransactions: y.transactions,
    monthSales: m.revenue,
    monthTransactions: m.transactions,
  };
}

/**
 * Stock in vs stock out for the period: every movement classified purely by the
 * sign of its quantity, so restocks/returns/void-reversals count as "in" and
 * sales/damage/loss/supplier-returns count as "out" without a hardcoded type list.
 */
export async function stockMovementsReport(ctx, query) {
  const r = resolveRange(query, ctx.business.timezone);
  const match = { shopId: ctx.shopId, createdAt: { $gte: r.start, $lt: r.end } };
  const inOut = { in: { $sum: { $cond: [{ $gt: ['$quantity', 0] }, '$quantity', 0] } }, out: { $sum: { $cond: [{ $lt: ['$quantity', 0] }, { $abs: '$quantity' }, 0] } } };

  const [byType, byVariant] = await Promise.all([
    InventoryMovement.aggregate([{ $match: match }, { $group: { _id: '$type', ...inOut, count: { $sum: 1 } } }]),
    InventoryMovement.aggregate([{ $match: match }, { $group: { _id: '$productVariantId', ...inOut } }, { $sort: { in: -1, out: -1 } }]),
  ]);

  const variants = await ProductVariant.find({ _id: { $in: byVariant.map((v) => v._id) } }, 'name size productId')
    .populate('productId', 'category')
    .lean();
  const variantById = new Map(variants.map((v) => [String(v._id), v]));

  const totals = byType.reduce((acc, t) => ({ in: acc.in + t.in, out: acc.out + t.out }), { in: 0, out: 0 });

  return {
    range: { range: r.range, start: r.start, end: r.end, days: r.granularity === 'day' ? r.buckets.length : 1 },
    totals: { in: totals.in, out: totals.out, net: totals.in - totals.out },
    byType: MOVEMENT_TYPES.map((type) => byType.find((t) => t._id === type) || { _id: type, in: 0, out: 0, count: 0 })
      .filter((t) => t.count > 0)
      .map((t) => ({ type: t._id, in: t.in, out: t.out, count: t.count })),
    byProduct: byVariant.map((v) => {
      const variant = variantById.get(String(v._id));
      return {
        variantId: String(v._id),
        name: variant?.name || 'Unknown product',
        size: variant?.size || '',
        category: variant?.productId?.category || '',
        in: v.in,
        out: v.out,
        net: v.in - v.out,
      };
    }),
  };
}
