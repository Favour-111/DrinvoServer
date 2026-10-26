import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { seedBusiness, startTestDb } from './helpers.js';

let db;
let env;
let svc;
let M;

const customer = { name: 'Walk In', phone: '08000000000' };
const sale = (ctx, items, extra = {}) => svc.sale.createSale(ctx, { items, paymentMethod: 'CASH', customer, ...extra });
const stockOf = async (ctx, variantId) => (await M.Inventory.findOne({ shopId: ctx.shopId, productVariantId: variantId }).lean())?.quantity ?? 0;
const miniVariant = (extra = {}) => ({
  size: '5cl',
  costPrice: 62.5,
  sellingPrice: 100,
  unitConversions: { pack: 12, carton: 144 },
  unitPrices: { pack: 1000, carton: 12000 },
  unitCosts: { pack: 750, carton: 9000 },
  lowStockThreshold: 24,
  ...extra,
});

before(async () => {
  db = await startTestDb();
  M = await import('../src/models/index.js');
  svc = {
    product: await import('../src/services/product.service.js'),
    purchase: await import('../src/services/purchase.service.js'),
    sale: await import('../src/services/sale.service.js'),
    ret: await import('../src/services/return.service.js'),
    transfer: await import('../src/services/transfer.service.js'),
    count: await import('../src/services/stockcount.service.js'),
    inventory: await import('../src/services/inventory.service.js'),
    report: await import('../src/services/report.service.js'),
  };
  env = await seedBusiness();
});
after(async () => db?.stop());

// ---- shared state across the ordered lifecycle below ----
const s = {};

test('1. a standard drink is created and behaves exactly as before', async () => {
  const ctx = env.adminA();
  const { id } = await svc.product.createProduct(ctx, {
    name: 'Cola',
    category: 'Soft Drink',
    variants: [{ size: '50cl', costPrice: 650, sellingPrice: 800, unitConversions: { pack: 6, carton: 24 }, unitPrices: {}, unitCosts: {}, lowStockThreshold: 0, openingStock: { quantity: 48, unit: 'bottle' } }],
  });
  const product = await M.Product.findById(id).lean();
  assert.equal(product.packagingType, 'STANDARD');
  s.std = await M.ProductVariant.findOne({ productId: id }).lean();
  assert.equal(await stockOf(ctx, s.std._id), 48);

  const r = await sale(env.staffA(), [{ variantId: String(s.std._id), unit: 'carton', quantity: 1 }]);
  assert.equal(await stockOf(ctx, s.std._id), 24);
  const line = await M.SaleItem.findOne({ saleId: r.id }).lean();
  assert.equal(line.baseQuantity, 24);
  assert.equal(line.packagingType, 'STANDARD');
  assert.equal(line.lineTotal, 800 * 24);
  const rows = await svc.inventory.stockRows(ctx);
  const row = rows.find((x) => x.variantId === String(s.std._id));
  assert.equal(row.isMiniature, false);
  assert.equal(row.stockBreakdown, undefined);
});

test('2-3. a miniature drink is created: 12 bottles per pack, 12 packs per carton = 144 bottles', async () => {
  const ctx = env.adminA();
  const { id } = await svc.product.createProduct(ctx, { name: 'Mini Brandy', category: 'Spirits', packagingType: 'MINIATURE', variants: [miniVariant()] });
  s.miniProduct = id;
  s.mini = await M.ProductVariant.findOne({ productId: id }).lean();
  const row = (await svc.inventory.stockRows(ctx)).find((x) => x.variantId === String(s.mini._id));
  assert.equal(row.packagingType, 'MINIATURE');
  assert.equal(row.bottlesPerPack, 12);
  assert.equal(row.packsPerCarton, 12);
  assert.equal(row.bottlesPerCarton, 144);
  assert.deepEqual(row.unitCosts, { pack: 750, carton: 9000, crate: 0 });
});

test('3b. invalid miniature packaging is rejected by the service layer on edit', async () => {
  const ctx = env.adminA();
  // Switching a standard product (6/24 is fine) but with a crate is not allowed for miniatures
  const { id } = await svc.product.createProduct(ctx, { name: 'Cola Crate', category: 'Soft Drink', variants: [{ size: '35cl', costPrice: 100, sellingPrice: 150, unitConversions: { pack: 6, carton: 24, crate: 30 }, unitPrices: {}, unitCosts: {}, lowStockThreshold: 0 }] });
  await assert.rejects(svc.product.updateProduct(ctx, id, { packagingType: 'MINIATURE' }), /bottle, pack and carton only|whole number/);
  assert.equal((await M.Product.findById(id).lean()).packagingType, 'STANDARD');
});

test('4. purchasing 5 cartons at N9,000 adds 720 bottles and records N45,000 once', async () => {
  const ctx = env.adminA();
  const r = await svc.purchase.createPurchase(ctx, { supplierId: String(env.supplier._id), items: [{ variantId: String(s.mini._id), unit: 'carton', quantity: 5, costPerUnit: 9000 }] });
  assert.equal(r.totalCost, 45000);
  assert.equal(r.lines[0].baseQuantity, 720);
  assert.equal(await stockOf(ctx, s.mini._id), 720);
  const inv = await M.Inventory.findOne({ shopId: ctx.shopId, productVariantId: s.mini._id }).lean();
  assert.equal(inv.avgCost, 62.5); // 45,000 / 720, not 45,000 x 144
  const item = await M.PurchaseItem.findOne({ purchaseId: r.id }).lean();
  assert.deepEqual([item.unit, item.quantity, item.conversion, item.baseQuantity, item.costPerUnit, item.lineTotal], ['carton', 5, 144, 720, 9000, 45000]);
  const mv = await M.InventoryMovement.findOne({ referenceId: r.id, productVariantId: s.mini._id }).lean();
  assert.equal(mv.type, 'RESTOCK');
  assert.equal(mv.quantity, 720);
  assert.equal(mv.balanceAfter, 720);
});

test('5-7, 9, 10. selling 3 packs, 10 bottles and 2 cartons deducts 36, 10 and 288 bottles at configured prices', async () => {
  const ctx = env.adminA();
  const staff = env.staffA();
  const v = String(s.mini._id);

  const packs = await sale(staff, [{ variantId: v, unit: 'pack', quantity: 3 }]);
  assert.equal(await stockOf(ctx, s.mini._id), 684);
  let line = await M.SaleItem.findOne({ saleId: packs.id }).lean();
  assert.deepEqual([line.packagingType, line.unit, line.quantity, line.conversion, line.baseQuantity, line.unitPrice, line.lineTotal], ['MINIATURE', 'pack', 3, 12, 36, 1000, 3000]);
  assert.equal(line.lineCost, 2250); // 36 bottles x 62.5
  s.packSale = packs.id;

  await sale(staff, [{ variantId: v, unit: 'bottle', quantity: 10 }]);
  assert.equal(await stockOf(ctx, s.mini._id), 674);

  const cartons = await sale(staff, [{ variantId: v, unit: 'carton', quantity: 2 }]);
  assert.equal(await stockOf(ctx, s.mini._id), 386);
  line = await M.SaleItem.findOne({ saleId: cartons.id }).lean();
  assert.deepEqual([line.baseQuantity, line.unitPrice, line.lineTotal], [288, 12000, 24000]);
  const full = await svc.sale.getSale(ctx, cartons.id);
  assert.equal(full.total, 24000);
  assert.equal(full.totalCost, 18000);
  assert.equal(full.profit, 6000);
  assert.equal(full.items[0].packagingType, 'MINIATURE');

  // Every deduction is in the ledger in bottles, referencing the receipt
  const mv = await M.InventoryMovement.find({ productVariantId: s.mini._id, type: 'SALE' }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(mv.map((m) => m.quantity), [-36, -10, -288]);
});

test('8. a sale that exceeds available stock is refused and changes nothing', async () => {
  const ctx = env.adminA();
  const before = await stockOf(ctx, s.mini._id); // 386
  await assert.rejects(sale(env.staffA(), [{ variantId: String(s.mini._id), unit: 'carton', quantity: 3 }]), /Not enough stock/);
  assert.equal(await stockOf(ctx, s.mini._id), before);
  assert.equal(await M.SaleItem.countDocuments({ productVariantId: s.mini._id, quantity: 3, unit: 'carton' }), 0);
});

test('18. invalid quantities, prices and units are refused', async () => {
  const v = String(s.mini._id);
  const staff = env.staffA();
  await assert.rejects(sale(staff, [{ variantId: v, unit: 'crate', quantity: 1 }]), /not sold by the crate/);
  await assert.rejects(sale(staff, [{ variantId: v, unit: 'pack', quantity: 1, price: -5 }]), /negative/);
  // The same unit is refused for a standard drink that has no crate set up
  await assert.rejects(sale(staff, [{ variantId: String(s.std._id), unit: 'crate', quantity: 1 }]), /not sold by the crate/);
  assert.equal(await stockOf(env.adminA(), s.mini._id), 386);
});

test('11. discounts: a discounted pack price is recorded and the receipt line keeps the unit', async () => {
  const ctx = env.adminA();
  const v = String(s.mini._id);
  const r = await sale(env.staffA(), [{ variantId: v, unit: 'pack', quantity: 2, price: 950 }]);
  const view = await svc.sale.getSale(ctx, r.id);
  const item = view.items[0];
  assert.deepEqual([item.unit, item.quantity, item.baseQuantity, item.listPrice, item.unitPrice, item.discount, item.lineTotal], ['pack', 2, 24, 1000, 950, 50, 1900]);
  assert.equal(view.totalDiscount, 100);
  assert.equal(view.total, 1900);
  assert.equal(await stockOf(ctx, s.mini._id), 362);
});

test('15. historical receipts keep their original prices and units after prices and packaging change', async () => {
  const ctx = env.adminA();
  const before = await svc.sale.getSale(ctx, s.packSale);
  await svc.product.updateProduct(ctx, s.miniProduct, {
    variants: [miniVariant({ id: String(s.mini._id), sellingPrice: 120, unitPrices: { pack: 1300, carton: 15000 }, unitConversions: { pack: 10, carton: 120 } })],
  });
  const after = await svc.sale.getSale(ctx, s.packSale);
  assert.deepEqual(after.items, before.items);
  assert.equal(after.items[0].conversion, 12);
  assert.equal(after.items[0].unitPrice, 1000);
});

test('16. changing packaging never changes the bottles on hand, and is written to the audit log', async () => {
  const ctx = env.adminA();
  assert.equal(await stockOf(ctx, s.mini._id), 362); // untouched by the edit above
  const log = await M.AuditLog.findOne({ action: 'product.packaging_changed', entityId: s.mini._id }).lean();
  assert.ok(log, 'packaging change was audited');
  assert.match(log.detail, /1 pack = 12 → 10 bottles/);
  assert.match(log.detail, /362 bottles in stock unchanged/);
  // A bad edit is refused outright
  await assert.rejects(
    svc.product.updateProduct(ctx, s.miniProduct, { packagingType: 'MINIATURE', variants: [miniVariant({ id: String(s.mini._id), unitConversions: { pack: 10, carton: 125 } })] }),
    /whole number of packs/
  );
  // Sales now use the new conversion; stock is still just bottles
  const r = await sale(env.staffA(), [{ variantId: String(s.mini._id), unit: 'pack', quantity: 1 }]);
  assert.equal((await M.SaleItem.findOne({ saleId: r.id }).lean()).baseQuantity, 10);
  assert.equal(await stockOf(ctx, s.mini._id), 352);
  // restore the 12/144 packaging for the remaining tests
  await svc.product.updateProduct(ctx, s.miniProduct, { variants: [miniVariant({ id: String(s.mini._id), unitConversions: { pack: 12, carton: 144 } })] });
});

test('12. transfers: 2 cartons = 288 bottles out of one branch and into the other, as 2 cartons in history', async () => {
  const a = env.adminA();
  const b = env.adminB();
  const v = String(s.mini._id);
  const fromBefore = await stockOf(a, s.mini._id);
  const r = await svc.transfer.createStockTransfer(a, { fromShopId: String(env.shopA._id), toShopId: String(env.shopB._id), items: [{ variantId: v, unit: 'carton', quantity: 2 }], notes: '' });
  assert.equal(await stockOf(a, s.mini._id), fromBefore - 288);
  assert.equal(await stockOf(b, s.mini._id), 288);
  const t = await svc.transfer.getTransfer(a, r.id);
  assert.deepEqual([t.items[0].unit, t.items[0].quantity, t.items[0].baseQuantity], ['carton', 2, 288]);
  const out = await M.InventoryMovement.findOne({ referenceId: r.id, type: 'TRANSFER_OUT' }).lean();
  const into = await M.InventoryMovement.findOne({ referenceId: r.id, type: 'TRANSFER_IN' }).lean();
  assert.deepEqual([out.quantity, into.quantity, String(out.shopId), String(into.shopId)], [-288, 288, String(env.shopA._id), String(env.shopB._id)]);
  // One product record serves both branches
  assert.equal(await M.ProductVariant.countDocuments({ productId: s.miniProduct }), 1);
  // And the cost basis travels with the stock
  assert.equal((await M.Inventory.findOne({ shopId: env.shopB._id, productVariantId: s.mini._id }).lean()).avgCost, 62.5);
  await assert.rejects(svc.transfer.createStockTransfer(a, { fromShopId: String(env.shopA._id), toShopId: String(env.shopB._id), items: [{ variantId: v, unit: 'carton', quantity: 50 }], notes: '' }), /Not enough stock/);
  assert.equal(await stockOf(b, s.mini._id), 288);
});

test('13. a physical count of 3 cartons + 4 packs + 5 bottles is 485 bottles; the variance is recorded without moving stock', async () => {
  const ctx = env.adminB(); // Branch Shop holds 288
  const expected = await stockOf(ctx, s.mini._id);
  const c = await svc.count.createStockCount(ctx, { items: [{ variantId: String(s.mini._id), counts: [{ unit: 'carton', quantity: 3 }, { unit: 'pack', quantity: 4 }, { unit: 'bottle', quantity: 5 }] }], notes: '' });
  const line = c.items[0];
  assert.equal(line.physicalQuantity, 485);
  assert.equal(line.expectedQuantity, expected);
  assert.equal(line.difference, 485 - expected);
  assert.equal(line.type, 'OVERAGE');
  assert.equal(await stockOf(ctx, s.mini._id), expected, 'a count alone never changes stock');
  // Resolving it is a separate, recorded adjustment
  const adj = await svc.inventory.createAdjustment(ctx, { variantId: String(s.mini._id), type: 'CORRECTION', direction: 'add', quantity: 197, unit: 'bottle', notes: `Count ${c.countNumber}` });
  assert.equal(adj.balanceAfter, 485);
  assert.equal(await M.InventoryMovement.countDocuments({ shopId: env.shopB._id, productVariantId: s.mini._id, type: 'ADJUSTMENT' }), 1);
});

test('14. low-stock alerts use the bottle threshold', async () => {
  const ctx = env.adminA();
  const v = String(s.mini._id);
  const row = async () => (await svc.inventory.stockRows(ctx)).find((x) => x.variantId === v);
  const left = (await row()).quantity;
  // Sell down to exactly the 24-bottle threshold, then to zero
  await sale(env.staffA(), [{ variantId: v, unit: 'bottle', quantity: left - 24 }]);
  assert.equal((await row()).status, 'low');
  assert.equal((await svc.report.dashboard(ctx, {})).lowStock.some((x) => x.variantId === v), true);
  await sale(env.staffA(), [{ variantId: v, unit: 'bottle', quantity: 24 }]);
  assert.equal((await row()).status, 'out');
});

test('returns restock miniature sales by the unit sold', async () => {
  const ctx = env.adminA();
  const before = await stockOf(ctx, s.mini._id); // 0
  const r = await svc.sale.getSale(ctx, s.packSale);
  await svc.ret.processReturn(ctx, s.packSale, { items: [{ saleItemId: r.items[0].id, quantity: 1 }], reason: 'Damaged box', restock: true, refundMethod: 'CASH' });
  assert.equal(await stockOf(ctx, s.mini._id), before + 12);
  const after = await svc.sale.getSale(ctx, s.packSale);
  assert.equal(after.returnedAmount, 1000);
});

test('17. concurrent sales can never take stock below zero', async () => {
  const ctx = env.adminA();
  const { id } = await svc.product.createProduct(ctx, { name: 'Mini Gin', category: 'Spirits', packagingType: 'MINIATURE', variants: [miniVariant({ openingStock: { quantity: 720, unit: 'bottle' } })] });
  const v = String((await M.ProductVariant.findOne({ productId: id }).lean())._id);
  // 8 tills each try to sell 1 carton (144) at once; only 5 fit in 720 bottles
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => sale(env.staffA(), [{ variantId: v, unit: 'carton', quantity: 1 }])));
  const ok = results.filter((x) => x.status === 'fulfilled').length;
  assert.equal(ok, 5);
  assert.equal(await stockOf(ctx, v), 0);
  assert.equal(await M.SaleItem.countDocuments({ productVariantId: v }), 5);
  const movements = await M.InventoryMovement.find({ productVariantId: v, type: 'SALE' }).lean();
  assert.equal(movements.reduce((n, m) => n + m.quantity, 0), -720);
  assert.ok(movements.every((m) => m.balanceAfter >= 0));
});

test('9-10. reports: miniature totals are a subset of the overall totals and profit uses the real cost', async () => {
  const ctx = env.adminA();
  const r = await svc.report.summary(ctx, { range: '30d' });
  const mini = r.miniature;
  assert.ok(mini.byUnit.pack >= 5 && mini.byUnit.carton >= 7 && mini.byUnit.bottle >= 10);
  assert.ok(mini.bottlesSold > 0);
  assert.equal(Math.round((mini.revenue - mini.cost) * 100) / 100, mini.grossProfit);
  assert.ok(mini.revenue <= r.totals.revenue, 'miniature revenue is inside the overall revenue, not added on top');
  assert.ok(mini.cost <= r.totals.cost);
  // Standard sales are in the totals but not in the miniature figures
  const stdRevenue = 800 * 24;
  assert.ok(r.totals.revenue >= mini.revenue + stdRevenue);
  assert.deepEqual(r.miniature.byShop.map((x) => x.shopName), ['Main Shop', 'Branch Shop']);
  assert.equal(r.miniature.byShop[1].bottles, 485);
  const inv = await svc.inventory.listInventory(ctx, {});
  assert.equal(inv.summary.miniature.variantCount, 2);
  assert.equal(inv.summary.variantCount, 4, 'overall inventory counts every product once');
});

test('19. products and sales created before this feature (no packaging fields) still work', async () => {
  const ctx = env.adminA();
  // Simulate a pre-feature document: no packagingType on the product or sale line, no unitCosts on the size
  const { id } = await svc.product.createProduct(ctx, { name: 'Legacy Malt', category: 'Malt Drink', variants: [{ size: '33cl', costPrice: 300, sellingPrice: 400, unitConversions: { carton: 24 }, unitPrices: {}, unitCosts: {}, lowStockThreshold: 0, openingStock: { quantity: 48, unit: 'bottle' } }] });
  await M.Product.collection.updateOne({ _id: new db.mongoose.Types.ObjectId(id) }, { $unset: { packagingType: '' } });
  await M.ProductVariant.collection.updateOne({ productId: new db.mongoose.Types.ObjectId(id) }, { $unset: { unitCosts: '' } });
  const v = String((await M.ProductVariant.findOne({ productId: id }).lean())._id);
  const row = (await svc.inventory.stockRows(ctx)).find((x) => x.variantId === v);
  assert.equal(row.packagingType, 'STANDARD');
  assert.deepEqual(row.unitCosts, { pack: 0, carton: 0, crate: 0 });
  const r = await sale(env.staffA(), [{ variantId: v, unit: 'carton', quantity: 1 }]);
  await M.SaleItem.collection.updateOne({ saleId: new db.mongoose.Types.ObjectId(r.id) }, { $unset: { packagingType: '' } });
  const view = await svc.sale.getSale(ctx, r.id);
  assert.equal(view.items[0].packagingType, 'STANDARD');
  assert.equal(await stockOf(ctx, v), 24);
  // A pre-feature product can be edited and switched to Miniature without touching its stock
  await svc.product.updateProduct(ctx, id, { name: 'Legacy Malt' });
  assert.equal(await stockOf(ctx, v), 24);
});

test('staff never receive cost fields for miniature stock', async () => {
  const { sendScoped } = await import('../src/utils/serialize.js');
  const rows = await svc.inventory.stockRows(env.staffA());
  let body;
  sendScoped({ user: env.staffA().user }, { status: () => ({ json: (b) => (body = b) }) }, { items: rows });
  const mini = body.items.find((x) => x.isMiniature);
  for (const key of ['costPrice', 'avgCost', 'unitCosts', 'inventoryValue']) assert.equal(key in mini, false, key);
  assert.equal(mini.unitConversions.carton, 144);
});
