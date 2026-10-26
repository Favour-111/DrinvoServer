import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { productCreateSchema, productUpdateSchema, restockSchema, saleCreateSchema } from '../src/validators/index.js';

const variant = (extra = {}) => ({ size: '5cl', costPrice: 62.5, sellingPrice: 100, unitConversions: { pack: 12, carton: 144 }, ...extra });
const product = (extra = {}) => ({ name: 'Mini Brandy', category: 'Spirits', packagingType: 'MINIATURE', variants: [variant()], ...extra });

test('a valid miniature product passes and keeps its packaging type', () => {
  const r = productCreateSchema.safeParse(product());
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  assert.equal(r.data.packagingType, 'MINIATURE');
});

test('products default to STANDARD and standard products skip miniature checks', () => {
  const r = productCreateSchema.safeParse({ name: 'Cola', category: 'Soft Drink', variants: [variant({ unitConversions: { pack: 6, carton: 25 } })] });
  assert.ok(r.success);
  assert.equal(r.data.packagingType, 'STANDARD');
});

test('invalid miniature packaging is rejected', () => {
  for (const unitConversions of [{ pack: 0, carton: 144 }, { pack: 12, carton: 0 }, { pack: 12, carton: 100 }, { pack: 12, carton: 144, crate: 24 }, { pack: 1.5, carton: 144 }, { pack: -12, carton: 144 }]) {
    assert.equal(productCreateSchema.safeParse(product({ variants: [variant({ unitConversions })] })).success, false, JSON.stringify(unitConversions));
  }
});

test('negative prices and costs are rejected', () => {
  assert.equal(productCreateSchema.safeParse(product({ variants: [variant({ costPrice: -1 })] })).success, false);
  assert.equal(productCreateSchema.safeParse(product({ variants: [variant({ unitPrices: { pack: -5 } })] })).success, false);
  assert.equal(productCreateSchema.safeParse(product({ variants: [variant({ unitCosts: { carton: -5 } })] })).success, false);
});

test('unknown packaging types are rejected; partial updates may omit the type', () => {
  assert.equal(productCreateSchema.safeParse(product({ packagingType: 'GIANT' })).success, false);
  const r = productUpdateSchema.safeParse({ name: 'Renamed' });
  assert.ok(r.success);
  assert.equal(r.data.packagingType, undefined);
});

test('restock and sale lines need whole, positive quantities and non-negative money', () => {
  const id = 'a'.repeat(24);
  assert.equal(restockSchema.safeParse({ supplierId: id, items: [{ variantId: id, unit: 'carton', quantity: 5, costPerUnit: 9000 }] }).success, true);
  assert.equal(restockSchema.safeParse({ supplierId: id, items: [{ variantId: id, unit: 'carton', quantity: 0, costPerUnit: 9000 }] }).success, false);
  assert.equal(restockSchema.safeParse({ supplierId: id, items: [{ variantId: id, unit: 'carton', quantity: 1.5, costPerUnit: 9000 }] }).success, false);
  assert.equal(restockSchema.safeParse({ supplierId: id, items: [{ variantId: id, unit: 'carton', quantity: 1, costPerUnit: -9 }] }).success, false);
  const sale = (items) => saleCreateSchema.safeParse({ items, paymentMethod: 'CASH', customer: { name: 'Walk In', phone: '08000000000' } });
  assert.equal(sale([{ variantId: id, unit: 'pack', quantity: 3 }]).success, true);
  assert.equal(sale([{ variantId: id, unit: 'pallet', quantity: 3 }]).success, false);
  assert.equal(sale([{ variantId: id, unit: 'pack', quantity: -3 }]).success, false);
  assert.equal(sale([{ variantId: id, unit: 'pack', quantity: 3, price: -1 }]).success, false);
});
