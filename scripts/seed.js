/**
 * Seeds a demo business (Omojola Drinks, Main Shop) with 30 days of history.
 * Every sale, restock, return and adjustment goes through the real services,
 * so stock levels, weighted costs and movements are all consistent.
 *
 *   npm run seed            # only runs on an empty database
 *   npm run seed -- --force # erases an existing database first
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
import {
  AuditLog, Business, Counter, CreditPayment, InventoryMovement, Payment, Product, ProductVariant, Purchase, PurchaseItem,
  Refund, Return, ReturnItem, Sale, SaleItem, Shop, StockAdjustment, Supplier, User,
} from '../src/models/index.js';
import { createProduct } from '../src/services/product.service.js';
import { createPurchase } from '../src/services/purchase.service.js';
import { createSale } from '../src/services/sale.service.js';
import { processReturn, processRefund, voidSale } from '../src/services/return.service.js';
import { createAdjustment } from '../src/services/inventory.service.js';
import { createCustomer, recordCreditPayment } from '../src/services/customer.service.js';
import { createSupplier } from '../src/services/supplier.service.js';
import { startOfDay } from '../src/utils/dates.js';

const TZ = 'Africa/Lagos';
const PASSWORD = 'Password123!';
const DAYS = 30;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(20260925);
const pick = (a) => a[Math.floor(R() * a.length)];

/* Every record created inside `fn` gets its timestamps moved to `date`. */
async function at(date, fn) {
  const before = new Date(Date.now() - 1000);
  const result = await fn();
  const since = { $gte: before };
  const set = { $set: { createdAt: date, updatedAt: date } };
  const models = [Sale, SaleItem, Payment, InventoryMovement, AuditLog, Purchase, PurchaseItem, Return, ReturnItem, Refund, StockAdjustment, CreditPayment];
  await Promise.all(models.map((M) => M.collection.updateMany({ createdAt: since }, set)));
  return result;
}

const CATALOG = [
  { name: 'Coca-Cola', brand: 'Nigerian Bottling Company', category: 'Soft Drink', color: '#D92D20', shape: 'bottle', supplier: 0, description: 'Classic Coca-Cola. 35cl returnable glass, 50cl and 1L PET.',
    variants: [
      { size: '35cl Glass', cost: 230, price: 300, conv: { crate: 24 }, low: 96, weight: 14 },
      { size: '50cl', cost: 650, price: 800, conv: { pack: 6, carton: 24, crate: 24 }, prices: { pack: 4700, carton: 18500 }, low: 240, weight: 10, target: 192 },
      { size: '1L', cost: 900, price: 1100, conv: { pack: 6, carton: 12 }, low: 24, weight: 3 },
    ] },
  { name: 'Sprite', brand: 'Nigerian Bottling Company', category: 'Soft Drink', color: '#16A34A', shape: 'bottle', supplier: 0,
    variants: [{ size: '50cl', cost: 650, price: 800, conv: { pack: 6, carton: 24 }, prices: { carton: 18500 }, low: 240, weight: 6, target: 144 }] },
  { name: 'Fanta Orange', brand: 'Nigerian Bottling Company', category: 'Soft Drink', color: '#F97316', shape: 'bottle', supplier: 0,
    variants: [{ size: '50cl', cost: 640, price: 800, conv: { pack: 6, carton: 24 }, prices: { carton: 18500 }, low: 240, weight: 7 }] },
  { name: 'Pepsi', brand: 'Seven-Up Bottling Company', category: 'Soft Drink', color: '#1D4ED8', shape: 'bottle', supplier: 4,
    variants: [{ size: '50cl', cost: 600, price: 750, conv: { pack: 6, carton: 12 }, prices: { carton: 8700 }, low: 120, weight: 7 }] },
  { name: 'Maltina', brand: 'Nigerian Breweries', category: 'Malt Drink', color: '#B45309', shape: 'can', supplier: 1,
    variants: [{ size: '33cl', cost: 780, price: 1000, conv: { pack: 6, carton: 24 }, prices: { carton: 23000 }, low: 144, weight: 9, target: 96 }] },
  { name: 'Malta Guinness', brand: 'Guinness Nigeria', category: 'Malt Drink', color: '#78350F', shape: 'can', supplier: 2,
    variants: [{ size: '33cl', cost: 800, price: 1000, conv: { pack: 6, carton: 24 }, low: 144, weight: 6, target: 0, opening: 1.4 }] },
  { name: 'Eva Water', brand: 'Nigerian Bottling Company', category: 'Water', color: '#0EA5E9', shape: 'bottle', supplier: 0,
    variants: [
      { size: '75cl', cost: 220, price: 300, conv: { pack: 12 }, prices: { pack: 3300 }, low: 144, weight: 12 },
      { size: '1.5L', cost: 380, price: 500, conv: { pack: 6 }, low: 36, weight: 4, target: 18 },
    ] },
  { name: 'Chivita 100% Orange', brand: 'CHI Limited', category: 'Juice', color: '#EA580C', shape: 'box', supplier: 3,
    variants: [{ size: '1L', cost: 1650, price: 2000, conv: { carton: 10 }, low: 20, weight: 3 }] },
  { name: 'Red Bull', brand: 'Red Bull', category: 'Energy Drink', color: '#1E3A8A', shape: 'can', supplier: 5,
    variants: [{ size: '25cl', cost: 1300, price: 1600, conv: { pack: 4, carton: 24 }, low: 48, weight: 5 }] },
  { name: 'Star Lager', brand: 'Nigerian Breweries', category: 'Beer', color: '#15803D', shape: 'bottle', supplier: 1,
    variants: [{ size: '60cl', cost: 650, price: 850, conv: { crate: 12 }, prices: { crate: 9800 }, low: 60, weight: 9 }] },
];

// Regular walk-in buyers; every sale records who bought it
const BUYERS = [
  ['Chioma Eze', '0803 214 5561'], ['Tunde Alabi', '0805 331 7720'], ['Ngozi Obi', '0807 552 1934'], ['Ibrahim Musa', '0809 118 4402'],
  ['Funke Adeyemi', '0810 663 2098'], ['Emeka Okafor', '0812 774 3310'], ['Aisha Bello', '0813 205 6671'], ['Segun Ogunleye', '0814 390 1187'],
  ['Blessing Nwachukwu', '0815 447 9023'], ['Kunle Bakare', '0816 902 3345'], ['Halima Yusuf', '0817 330 5519'], ['Uche Nnamdi', '0818 661 2204'],
  ['Yemi Oladipo', '0703 559 8812'], ['Kemi Lawal', '0705 201 4476'], ['Femi Johnson', '0706 888 1290'], ['Amaka Obi', '0708 334 7715'],
  ['Sani Garba', '0901 227 6603'], ['Bisi Ajayi', '0902 745 1188'], ['Chinedu Nwosu', '0903 612 9947'], ['Tolu Adebayo', '0904 150 3362'],
].map(([name, phone]) => ({ name, phone }));

const SUPPLIERS = [
  { name: 'ABC Beverages Ltd', contacts: [{ name: 'Emeka Nwosu', phone: '0802 118 4410', email: 'orders@abcbeverages.ng' }], address: '22 Wharf Rd, Apapa, Lagos' },
  { name: 'NB Depot Surulere', contacts: [{ name: 'Kunle Adebayo', phone: '0803 660 1289', email: 'surulere@nbdepot.ng' }], address: '5 Bode Thomas St, Surulere, Lagos' },
  { name: 'Guinness Depot Ikeja', contacts: [{ name: 'Ifeoma Obi', phone: '0817 402 9934', email: 'ikeja@gdepot.ng' }], address: 'Plot 9, Oba Akran Ave, Ikeja' },
  { name: 'CHI Distribution Hub', contacts: [{ name: 'Segun Alade', phone: '0805 993 1120', email: 'hub@chidistro.ng' }], address: 'Km 14 Lagos-Ibadan Expy, Ogun' },
  {
    name: 'Seven-Up Direct',
    contacts: [
      { name: 'Aisha Bello', phone: '0810 245 7781', email: 'direct@sevenupng.com' },
      { name: 'Tunde Fashola', phone: '0810 245 7790', email: 'accounts@sevenupng.com' },
    ],
    address: 'Ijora Causeway, Lagos',
  },
  { name: 'Energy Plus Distributors', contacts: [{ name: 'David Etim', phone: '0708 118 6630', email: 'sales@energyplus.ng' }], address: '17 Allen Ave, Ikeja, Lagos' },
];

const CUSTOMERS = [
  { name: 'John Doe', businessName: "Doe's Canteen", phone: '0706 331 2290', address: 'Herbert Macaulay Way, Yaba' },
  { name: 'Titilayo Afolabi', businessName: 'Mama Titi Kitchen', phone: '0809 772 1043', address: 'Ojuelegba Rd, Surulere' },
  { name: 'Chinedu Okeke', businessName: 'Chinedu Events', phone: '0813 204 8876', address: 'Adelabu St, Surulere' },
  { name: 'Bola Ajayi', businessName: "Bola's Bukka", phone: '0705 118 9092', address: 'Aguda, Surulere' },
];

async function main() {
  await connectDB();
  if (env.isProd) throw new Error('Refusing to seed in production.');
  const existing = await User.countDocuments();
  if (existing && !process.argv.includes('--force')) {
    console.error(`This database already has ${existing} user account(s). Seeding would erase all of its data.\nRun "npm run seed -- --force" if you really want to replace it with demo data.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log('Clearing database…');
  // Clear each collection rather than dropping the database: hosted users (e.g. Atlas readWrite) may not drop databases
  await Promise.all(Object.values(mongoose.models).map((m) => m.deleteMany({})));
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

  const now = new Date();
  const todayStart = startOfDay(now, TZ);
  const dayStart = (daysAgo) => new Date(todayStart.getTime() - daysAgo * DAY);

  const business = await Business.create({ name: 'Omojola Drinks', timezone: TZ });
  const shop = await Shop.create({ businessId: business._id, name: 'Main Shop', address: '14 Adeniran Ogunsanya St, Surulere, Lagos', phone: '0803 412 7781' });
  const mk = (name, email, role, color, extra = {}) =>
    User.create({ businessId: business._id, shopIds: [shop._id], name, email, role, color, password: PASSWORD, phone: extra.phone || '', status: extra.status || 'ACTIVE' });
  const admin = await mk('Adaeze Omojola', 'admin@drinvo.test', 'ADMIN', '#047857', { phone: '0803 412 7781' });
  const john = await mk('John Okafor', 'john@drinvo.test', 'STAFF', '#1D5FD6', { phone: '0812 550 3309' });
  const blessing = await mk('Blessing Eze', 'blessing@drinvo.test', 'STAFF', '#B45309', { phone: '0706 214 8890' });
  const tunde = await mk('Tunde Bakare', 'tunde@drinvo.test', 'STAFF', '#7C3AED', { phone: '0909 331 0072' });
  const grace = await mk('Grace Adeyemi', 'grace@drinvo.test', 'STAFF', '#BE185D', { phone: '0815 777 2031' });

  const bizLean = business.toObject();
  const shopLean = shop.toObject();
  const ctxFor = (u) => ({ user: u, userId: u._id, businessId: business._id, business: bizLean, shopId: shop._id, shop: shopLean });
  const A = ctxFor(admin);

  console.log('Creating suppliers and products…');
  const supplierIds = [];
  for (const s of SUPPLIERS) supplierIds.push((await at(dayStart(DAYS + 5), () => createSupplier(A, s))).id);

  const variants = []; // { id, name, conv, prices, weight, hold, low, supplierIdx, cost }
  for (const p of CATALOG) {
    const { id } = await at(dayStart(DAYS + 4), () =>
      createProduct(A, {
        name: p.name, brand: p.brand, category: p.category, description: p.description || '', color: p.color, shape: p.shape,
        supplierId: supplierIds[p.supplier],
        variants: p.variants.map((v) => ({
          size: v.size, costPrice: v.cost, sellingPrice: v.price,
          // Demo floor: roughly cost plus a thin margin, so staff still have discount room below the default price.
          minimumSellingPrice: Math.round(((v.cost * 1.1) / 10)) * 10,
          unitConversions: { pack: v.conv.pack || 0, carton: v.conv.carton || 0, crate: v.conv.crate || 0 },
          unitPrices: { pack: v.prices?.pack || 0, carton: v.prices?.carton || 0, crate: v.prices?.crate || 0 },
          lowStockThreshold: v.low,
        })),
      })
    );
    const docs = await ProductVariant.find({ productId: id }).lean();
    for (const v of p.variants) {
      const d = docs.find((x) => x.size === v.size);
      variants.push({ ...v, id: String(d._id), name: d.name, supplierIdx: p.supplier, doc: d });
    }
  }

  const stock = new Map(variants.map((v) => [v.id, 0]));
  const bigUnit = (v) => (v.conv.carton ? 'carton' : v.conv.crate ? 'crate' : v.conv.pack ? 'pack' : 'bottle');
  const convOf = (v, u) => (u === 'bottle' ? 1 : v.conv[u]);

  async function restock(daysAgo, list, hour = 7) {
    const bySupplier = new Map();
    for (const { v, units } of list) {
      if (!bySupplier.has(v.supplierIdx)) bySupplier.set(v.supplierIdx, []);
      bySupplier.get(v.supplierIdx).push({ v, units });
    }
    for (const [sIdx, lines] of bySupplier) {
      const date = new Date(dayStart(daysAgo).getTime() + hour * HOUR + sIdx * 20_000);
      const drift = 1 + (DAYS - daysAgo) * 0.0015; // costs creep up slowly
      await at(date, () =>
        createPurchase(A, {
          supplierId: supplierIds[sIdx],
          notes: `Invoice ${1000 + Math.floor(R() * 8999)}`,
          items: lines.map(({ v, units }) => {
            const u = bigUnit(v);
            return { variantId: v.id, unit: u, quantity: units, costPerUnit: Math.round((v.cost * convOf(v, u) * drift) / 10) * 10 };
          }),
        })
      );
      for (const { v, units } of lines) stock.set(v.id, stock.get(v.id) + units * convOf(v, bigUnit(v)));
    }
  }

  console.log('Opening stock…');
  await restock(DAYS, variants.map((v) => ({ v, units: Math.ceil((v.low * (v.opening || 3.5)) / convOf(v, bigUnit(v))) })), 7);

  const customerIds = [];
  for (const c of CUSTOMERS) customerIds.push((await at(dayStart(DAYS - 1), () => createCustomer(A, c))).id);

  const totalWeight = variants.reduce((s, v) => s + v.weight, 0);
  const pickVariant = () => {
    let t = R() * totalWeight;
    for (const v of variants) if ((t -= v.weight) <= 0) return v;
    return variants[0];
  };
  const pays = ['CASH', 'CASH', 'CASH', 'CASH', 'POS', 'POS', 'POS', 'TRANSFER', 'TRANSFER'];
  const hourWeights = [0.25, 0.35, 0.5, 0.7, 0.95, 1.1, 0.9, 0.75, 0.8, 1, 1.2, 1.05, 0.7, 0.4];
  const hwTotal = hourWeights.reduce((a, b) => a + b, 0);
  const pickHour = () => {
    let t = R() * hwTotal;
    for (let i = 0; i < hourWeights.length; i++) if ((t -= hourWeights[i]) <= 0) return 8 + i;
    return 13;
  };

  const saleIds = [];
  let count = 0;
  console.log(`Simulating ${DAYS} days of trading…`);
  const Inventory = mongoose.model('Inventory');
  const invQty = async (v) => (await Inventory.findOne({ productVariantId: v.id }).lean())?.quantity || 0;
  const byName = (n) => variants.find((v) => v.name === n);
  const consumed = new Map(variants.map((v) => [v.id, 0]));
  const eod = (d, min = 0) => new Date(dayStart(d).getTime() + 22 * HOUR + min * 60_000);
  const HOLD = 4;

  for (let d = DAYS - 1; d >= 0; d--) {
    for (const v of variants) stock.set(v.id, await invQty(v));
    const elapsed = DAYS - 1 - d || 1;

    // Normal restocking every other morning. Sizes with an end-of-demo target are
    // topped up once, HOLD days out, to roughly land on that target.
    const needs = [];
    for (const v of variants) {
      if (v.target !== undefined) {
        if (d === HOLD && v.target > 0) {
          const want = v.target + (consumed.get(v.id) / elapsed) * HOLD - stock.get(v.id);
          const units = Math.ceil(want / convOf(v, bigUnit(v)));
          if (units > 0) needs.push({ v, units });
        } else if (d > HOLD + 4 && d % 2 === 0 && v.target > 0 && stock.get(v.id) < v.low * 1.8) {
          needs.push({ v, units: Math.ceil((v.low * 2.5) / convOf(v, bigUnit(v))) });
        }
      } else if (d % 2 === 0 && stock.get(v.id) < v.low * 1.8) {
        needs.push({ v, units: Math.ceil((v.low * 2.5) / convOf(v, bigUnit(v))) });
      }
    }
    if (needs.length) await restock(d, needs);

    const date = dayStart(d);
    const weekday = new Date(date.getTime() + 12 * HOUR).getUTCDay();
    const base = weekday === 5 || weekday === 6 ? 78 : weekday === 0 ? 48 : 62;
    const salesToday = Math.round(base * (0.85 + R() * 0.3));
    const nowHour = (now.getTime() - todayStart.getTime()) / HOUR;
    const times = Array.from({ length: salesToday }, () => pickHour() + R())
      .filter((h) => d > 0 || h < nowHour - 0.1)
      .sort((a, b) => a - b);

    for (const h of times) {
      const staff = d > 19 && R() < 0.2 ? grace : pick(d > 19 ? [john, blessing, tunde] : [john, blessing, blessing, tunde, tunde, john]);
      const lines = [];
      const n = 1 + Math.floor(R() * 3);
      for (let i = 0; i < n; i++) {
        const v = pickVariant();
        if (lines.some((l) => l.variantId === v.id)) continue;
        const units = ['bottle', ...['pack', 'carton', 'crate'].filter((u) => v.conv[u])];
        const unit = R() < 0.9 || units.length === 1 ? 'bottle' : pick(units.slice(1));
        const quantity = unit === 'bottle' ? 1 + Math.floor(R() * 4) : 1 + Math.floor(R() * (unit === 'pack' ? 2 : 1.4));
        const need = quantity * convOf(v, unit);
        if (stock.get(v.id) - need < 0) continue;
        stock.set(v.id, stock.get(v.id) - need);
        consumed.set(v.id, consumed.get(v.id) + need);
        lines.push({ variantId: v.id, unit, quantity });
      }
      if (!lines.length) continue;
      const credit = R() < 0.02;
      const when = new Date(date.getTime() + h * HOUR);
      const { id } = await at(when, () =>
        createSale(ctxFor(staff), {
          items: lines,
          paymentMethod: credit ? 'CREDIT' : pick(pays),
          ...(credit ? { customerId: pick(customerIds) } : { customer: pick(BUYERS) }),
        })
      );
      saleIds.push({ id, when, days: d });
      count++;
    }

    // End-of-day events, timed after the day's sales so stock history stays in order
    const today = saleIds.filter((s) => s.days === d);
    if ([26, 12, 2].includes(d) && today.length) {
      const s = today[Math.floor(today.length / 2)];
      const sale = await Sale.findById(s.id).lean();
      const item = await SaleItem.findOne({ saleId: sale._id }).lean();
      await at(eod(d, 5), () =>
        processReturn(A, s.id, { items: [{ saleItemId: String(item._id), quantity: 1 }], reason: 'Customer changed mind', restock: true, refundMethod: sale.paymentMethod === 'CREDIT' ? 'CREDIT' : 'CASH' })
      );
    }
    if (d === 18 && today.length) {
      await at(eod(d, 10), () => voidSale(A, today[today.length - 1].id, { reason: 'Customer cancelled before collection' }));
    }
    if (d === 6) {
      for (const s of today.slice().reverse()) {
        const sale = await Sale.findById(s.id).lean();
        if (sale.status === 'COMPLETED' && sale.paymentMethod !== 'CREDIT' && sale.total >= 1500) {
          await at(eod(d, 15), () => processRefund(A, s.id, { amount: 500, method: 'CASH', reason: 'Overcharged on carton price' }));
          break;
        }
      }
    }
    if (d === 8) {
      await at(eod(d, 20), () => createAdjustment(A, { variantId: byName('Eva Water 75cl').id, type: 'CORRECTION', direction: 'add', quantity: 2, unit: 'bottle', notes: 'Recount after monthly stock take.' }));
    }
    if (d === 5 && (await invQty(byName('Eva Water 1.5L'))) >= 6) {
      await at(eod(d, 20), () => createAdjustment(A, { variantId: byName('Eva Water 1.5L').id, type: 'EXPIRED', quantity: 6, unit: 'bottle', notes: 'Past best-before date, removed from shelf.' }));
    }
    if (d === 11 && (await invQty(byName('Star Lager 60cl'))) >= 12) {
      await at(eod(d, 20), () => createAdjustment(A, { variantId: byName('Star Lager 60cl').id, type: 'SUPPLIER_RETURN', quantity: 1, unit: 'crate', notes: '1 crate returned: broken seals.' }));
    }
    if (d === 3) {
      const accounts = await mongoose.model('CreditAccount').find().lean();
      for (const [i, acc] of accounts.entries()) {
        const owed = acc.totalCredit - acc.totalPaid;
        if (owed > 2000 && i % 4 !== 3) {
          const amount = Math.round((owed * (0.4 + R() * 0.4)) / 500) * 500;
          await at(eod(d, 25 + i), () => recordCreditPayment(A, { customerId: String(acc.customerId), amount, method: pick(['CASH', 'TRANSFER']) }));
        }
      }
    }
    if (d === 1 && (await invQty(byName('Coca-Cola 50cl'))) >= 3) {
      await at(eod(d, 30), () => createAdjustment(A, { variantId: byName('Coca-Cola 50cl').id, type: 'DAMAGED', quantity: 3, unit: 'bottle', notes: '3 bottles broken during unloading.' }));
    }
    process.stdout.write(`\r  day -${String(d).padStart(2)}  ${count} sales`);
  }
  console.log('');

  // Land the demo's low and out-of-stock sizes exactly: top up or sell down, timed last.
  console.log('Setting final stock levels…');
  const topUps = [];
  for (const v of variants.filter((x) => x.target !== undefined)) {
    const q = await invQty(v);
    const c = convOf(v, bigUnit(v));
    if (q < v.target) topUps.push({ v, units: Math.ceil((v.target - q) / c) });
  }
  if (topUps.length) await restock(0, topUps, (now.getTime() - todayStart.getTime()) / HOUR - 0.08);
  for (const v of variants.filter((x) => x.target !== undefined)) {
    const extra = (await invQty(v)) - v.target;
    if (extra <= 0) continue;
    console.log(`  returning ${extra} unsold bottles of ${v.name} to the supplier`);
    await at(new Date(now.getTime() - 2 * 60_000), () =>
      createAdjustment(A, { variantId: v.id, type: 'SUPPLIER_RETURN', quantity: extra, unit: 'bottle', notes: 'Unsold stock sent back with the delivery van.' })
    );
  }

  await User.updateOne({ _id: grace._id }, { $set: { status: 'INACTIVE', lastActiveAt: dayStart(19) } });
  await at(dayStart(18), async () =>
    AuditLog.create({ businessId: business._id, shopId: shop._id, userId: admin._id, category: 'staff', action: 'staff.deactivated', summary: 'deactivated staff', target: 'Grace Adeyemi' })
  );
  await User.updateMany({ status: 'ACTIVE' }, { $set: { lastActiveAt: new Date(now.getTime() - 5 * 60_000) } });

  const summary = await Promise.all([Sale.countDocuments(), Purchase.countDocuments(), InventoryMovement.countDocuments(), Counter.find().lean()]);
  console.log(`\nDone: ${summary[0]} sales, ${summary[1]} purchases, ${summary[2]} stock movements.`);
  console.log('\nSign in with:');
  console.log(`  Admin  admin@drinvo.test   ${PASSWORD}`);
  console.log(`  Staff  john@drinvo.test    ${PASSWORD}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
