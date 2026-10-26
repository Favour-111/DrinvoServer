import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { breakdownStock, costFor, describeStock, miniatureConversionError, miniatureLayout, packagingOf, priceFor, toBase } from '../src/utils/units.js';

const mini = (extra = {}) => ({
  name: 'Mini Brandy',
  packagingType: 'MINIATURE',
  costPrice: 62.5,
  sellingPrice: 100,
  unitConversions: { bottle: 1, pack: 12, carton: 144, crate: 0 },
  unitPrices: { pack: 0, carton: 0, crate: 0 },
  unitCosts: { pack: 0, carton: 0, crate: 0 },
  ...extra,
});
const standard = () => ({ name: 'Cola', costPrice: 650, sellingPrice: 800, unitConversions: { bottle: 1, pack: 6, carton: 24, crate: 0 }, unitPrices: {}, unitCosts: {} });

test('one carton is 12 packs of 12 bottles = 144 bottles', () => {
  assert.deepEqual(miniatureLayout(mini()), { bottlesPerPack: 12, packsPerCarton: 12, bottlesPerCarton: 144 });
  assert.equal(toBase(mini(), 'carton', 1).baseQuantity, 144);
  assert.equal(toBase(mini(), 'pack', 3).baseQuantity, 36);
  assert.equal(toBase(mini(), 'bottle', 10).baseQuantity, 10);
  assert.equal(toBase(mini(), 'carton', 5).baseQuantity, 720);
});

test('packaging is configurable per product', () => {
  const v = mini({ unitConversions: { bottle: 1, pack: 10, carton: 120 } });
  assert.deepEqual(miniatureLayout(v), { bottlesPerPack: 10, packsPerCarton: 12, bottlesPerCarton: 120 });
  assert.equal(toBase(v, 'carton', 2).baseQuantity, 240);
});

test('missing packagingType means STANDARD, and standard products get no miniature layout', () => {
  assert.equal(packagingOf(standard()), 'STANDARD');
  assert.equal(miniatureLayout(standard()), null);
  assert.equal(packagingOf({ product: { packagingType: 'MINIATURE' } }), 'MINIATURE');
});

test('a miniature is not sold by a unit it has no conversion for', () => {
  assert.throws(() => toBase(mini(), 'crate', 1), /not sold by the crate/);
});

test('prices: bottle, pack and carton are independent; unset ones default to bottle price x conversion', () => {
  assert.equal(priceFor(mini(), 'bottle'), 100);
  assert.equal(priceFor(mini(), 'pack'), 1200);
  assert.equal(priceFor(mini(), 'carton'), 14400);
  const discounted = mini({ unitPrices: { pack: 1000, carton: 12000, crate: 0 } });
  assert.equal(priceFor(discounted, 'pack'), 1000);
  assert.equal(priceFor(discounted, 'carton'), 12000);
  assert.equal(priceFor(discounted, 'bottle'), 100);
});

test('purchase cost: saved pack/carton cost wins; otherwise bottle cost x conversion', () => {
  assert.equal(costFor(mini(), 'pack'), 750);
  assert.equal(costFor(mini(), 'carton'), 9000);
  assert.equal(costFor(mini({ unitCosts: { pack: 0, carton: 8800, crate: 0 } }), 'carton'), 8800);
});

test('stock breakdown: 686 bottles = 4 cartons, 9 packs, 2 bottles (57 packs + 2 bottles)', () => {
  assert.deepEqual(breakdownStock(mini(), 686), { carton: 4, pack: 9, bottle: 2 });
  assert.equal(describeStock(mini(), 686), '4 cartons + 9 packs + 2 bottles');
  assert.equal(describeStock(mini(), 720), '5 cartons');
  assert.equal(describeStock(mini(), 0), '0 bottles');
  assert.equal(describeStock(mini(), 1), '1 bottle');
});

test('standard stock text is unchanged', () => {
  assert.equal(describeStock(standard(), 50), '2 cartons + 2 bottles');
  assert.equal(describeStock(standard(), 0), '0 bottles');
});

test('miniature packaging validation', () => {
  assert.equal(miniatureConversionError({ pack: 12, carton: 144 }), null);
  assert.match(miniatureConversionError({ pack: 0, carton: 144 }), /bottles are in a pack/);
  assert.match(miniatureConversionError({ pack: 12, carton: 0 }), /packs are in a carton/);
  assert.match(miniatureConversionError({ pack: 12, carton: 100 }), /whole number of packs/);
  assert.match(miniatureConversionError({ pack: 12, carton: 6 }), /whole number of packs/);
  assert.match(miniatureConversionError({ pack: 12, carton: 144, crate: 24 }), /bottle, pack and carton only/);
});
