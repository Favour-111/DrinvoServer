import { CreditAccount, CreditPayment, Inventory, InventoryMovement, Product, ProductVariant, Refund, Return, Shop, Sale, SaleItem, Supplier, PurchaseItem } from '../models/index.js';
import { MOVEMENT_TYPES } from '../config/constants.js';
import { resolveRange } from '../utils/dates.js';
import { stockRows, summarize, summarizeMiniature } from './inventory.service.js';
import { creditBalance } from './customer.service.js';
import { listAudit } from './audit.service.js';

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

/**
 * Miniature sales for the period, from the sale lines (net of returns). `bottles` is the quantity
 * actually deducted from stock; `byUnit` keeps what customers bought (e.g. 3 packs, not 36 bottles).
 * These are a subset of the overall totals, not an addition to them.
 */
async function miniatureSales(ctx, start, end) {
  const rows = await SaleItem.aggregate([
    { $match: { shopId: ctx.shopId, createdAt: { $gte: start, $lt: end }, voided: false, packagingType: 'MINIATURE' } },
    {
      $group: {
        _id: '$unit',
        quantity: { $sum: { $subtract: ['$quantity', '$returnedQuantity'] } },
        bottles: { $sum: { $subtract: ['$baseQuantity', '$returnedBaseQuantity'] } },
        revenue: { $sum: { $subtract: ['$lineTotal', '$returnedAmount'] } },
        cost: { $sum: { $subtract: ['$lineCost', '$returnedCost'] } },
      },
    },
  ]);
  const byUnit = { bottle: 0, pack: 0, carton: 0 };
  let bottles = 0;
  let revenue = 0;
  let cost = 0;
  for (const r of rows) {
    if (r._id in byUnit) byUnit[r._id] = r.quantity;
    bottles += r.bottles;
    revenue += r.revenue;
    cost += r.cost;
  }
  return { byUnit, bottlesSold: bottles, revenue: round2(revenue), cost: round2(cost), grossProfit: round2(revenue - cost) };
}

/** Miniature stock in every active shop, so branches can be compared. Admin-only (see the report routes). */
async function miniatureStockByShop(ctx) {
  const [shops, products] = await Promise.all([
    Shop.find({ businessId: ctx.businessId, isActive: true }).sort({ createdAt: 1, _id: 1 }).lean(),
    Product.find({ businessId: ctx.businessId, status: 'ACTIVE', packagingType: 'MINIATURE' }, '_id').lean(),
  ]);
  if (!products.length) return [];
  const variants = await ProductVariant.find({ productId: { $in: products.map((p) => p._id) }, status: 'ACTIVE' }, '_id').lean();
  const stock = await Inventory.aggregate([
    { $match: { shopId: { $in: shops.map((s) => s._id) }, productVariantId: { $in: variants.map((v) => v._id) } } },
    { $group: { _id: '$shopId', bottles: { $sum: '$quantity' }, value: { $sum: { $multiply: ['$quantity', '$avgCost'] } } } },
  ]);
  const byShop = new Map(stock.map((x) => [String(x._id), x]));
  return shops.map((s) => ({ shopId: String(s._id), shopName: s.name, bottles: byShop.get(String(s._id))?.bottles || 0, inventoryValue: round2(byShop.get(String(s._id))?.value) }));
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

/** The best-selling drinks by revenue, each with its share of all sales in the period. */
function topSellers(products, limit = 4) {
  const revenue = round2(products.reduce((s, p) => s + p.revenue, 0));
  const cost = round2(products.reduce((s, p) => s + p.cost, 0));
  const share = (amount) => (revenue ? round2((amount / revenue) * 100) : 0);
  const top = products.slice(0, limit);
  const rest = products.slice(limit);
  return {
    revenue,
    margin: revenue ? round2(((revenue - cost) / revenue) * 100) : 0,
    items: top.map((p) => ({ variantId: p.variantId, name: p.name, unitsSold: p.unitsSold, revenue: p.revenue, share: share(p.revenue) })),
    others: { count: rest.length, share: share(rest.reduce((s, p) => s + p.revenue, 0)) },
  };
}

/** The latest restocked lines (newest first), with the product look-alike fields the thumbnails need. */
async function recentRestocks(ctx, rows, limit = 6) {
  const items = await PurchaseItem.find({ shopId: ctx.shopId }).sort({ createdAt: -1 }).limit(limit).lean();
  if (!items.length) return [];
  const suppliers = await Supplier.find({ _id: { $in: items.map((i) => i.supplierId) } }, 'name').lean();
  const supplierName = new Map(suppliers.map((x) => [String(x._id), x.name]));
  const byVariant = new Map(rows.map((r) => [String(r.variantId), r]));
  return items.map((i) => {
    const v = byVariant.get(String(i.productVariantId));
    return {
      id: String(i._id),
      variantId: String(i.productVariantId),
      name: v?.name || 'Archived product',
      color: v?.color,
      shape: v?.shape,
      image: v?.image,
      unit: i.unit,
      quantity: i.quantity,
      total: round2(i.lineTotal),
      supplier: supplierName.get(String(i.supplierId)) || '',
      createdAt: i.createdAt,
    };
  });
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
  const [totals, points, products, returns, refunds, payments, outstanding, miniature, miniatureStock, miniatureByShop] = await Promise.all([
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
    miniatureSales(ctx, r.start, r.end),
    stockRows(ctx).then(summarizeMiniature),
    miniatureStockByShop(ctx),
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
    miniature: { ...miniature, stock: miniatureStock, byShop: miniatureByShop },
  };
}

/** Only what the dashboard shows: headline numbers, the chart, stock alerts and recent sales. */
export async function dashboard(ctx, query) {
  const tz = ctx.business.timezone;
  const today = resolveRange({ range: 'today' }, tz);
  const yesterday = resolveRange({ range: 'yesterday' }, tz);
  const chartRange = resolveRange(query.range ? query : { range: '7d' }, tz);
  const last30 = resolveRange({ range: '30d' }, tz);

  // Everything runs in parallel: one database round trip for the whole page (plus sale lines)
  const [todayTotals, yesterdayTotals, todayCollected, yesterdayCollected, points, chartTotals, rows, recentSales, todayMiniature, products30, activity] = await Promise.all([
    saleTotals(ctx, today.start, today.end),
    saleTotals(ctx, yesterday.start, yesterday.end),
    creditCollected(ctx, today.start, today.end),
    creditCollected(ctx, yesterday.start, yesterday.end),
    series(ctx, chartRange),
    saleTotals(ctx, chartRange.start, chartRange.end),
    stockRows(ctx),
    Sale.find({ shopId: ctx.shopId }).sort({ createdAt: -1 }).limit(6).populate('staffId', 'name color').populate('customerId', 'name phone').lean(),
    miniatureSales(ctx, today.start, today.end),
    productProfitability(ctx, last30.start, last30.end),
    listAudit(ctx, { limit: 6 }),
  ]);
  const restocks = await recentRestocks(ctx, rows);
  const saleItems = await SaleItem.find({ saleId: { $in: recentSales.map((s) => s._id) } }, 'saleId variantName unit quantity').lean();

  return {
    today: { ...todayTotals, cashCollected: todayCollected },
    yesterday: { ...yesterdayTotals, cashCollected: yesterdayCollected },
    inventory: summarize(rows),
    miniature: { today: todayMiniature, stock: summarizeMiniature(rows) },
    chart: { range: chartRange.range, granularity: chartRange.granularity, points, totals: chartTotals },
    topSellers: topSellers(products30),
    stockHealth: rows.map((r) => ({ variantId: r.variantId, name: r.name, status: r.status })),
    recentActivity: activity.items,
    recentRestocks: restocks,
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
