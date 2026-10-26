import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { seedBusiness, startTestDb } from './helpers.js';

let db;
let server;
let base;
let tokens;
let env;

const call = async (method, path, token, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const login = async (email) => (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Password123!' }) })).json()).token;

before(async () => {
  db = await startTestDb();
  env = await seedBusiness();
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
  tokens = { admin: await login('admin@test.dev'), staff: await login('staff@test.dev') };
});
after(async () => {
  server?.close();
  await db?.stop();
});

const id = 'a'.repeat(24);
const restricted = [
  ['GET', '/stock-counts'],
  ['POST', '/stock-counts', { items: [{ variantId: id, counts: [{ unit: 'bottle', quantity: 1 }] }] }],
  ['GET', '/borrowings'],
  ['POST', '/borrowings', { direction: 'LENT', counterpartyName: 'Ade', items: [{ variantId: id, counts: [{ unit: 'bottle', quantity: 1 }] }] }],
  ['GET', '/on-demand-purchases'],
  ['POST', '/on-demand-purchases', { variantId: id, requestedQuantity: 1, unit: 'bottle', purchasedFrom: 'Market' }],
  ['GET', '/transfers'],
  ['POST', '/transfers', { fromShopId: id, toShopId: 'b'.repeat(24), items: [{ variantId: id, unit: 'bottle', quantity: 1 }] }],
  ['POST', '/credit/payments', { customerId: id, amount: 500, method: 'CASH' }],
];

test('staff are refused physical counts, borrow/lend, on-demand purchases, transfers and credit repayments', async () => {
  for (const [method, path, body] of restricted) {
    const r = await call(method, path, tokens.staff, body);
    assert.equal(r.status, 403, `${method} ${path} should be 403 for staff, got ${r.status}`);
  }
});

test('admins are not blocked by those permissions', async () => {
  for (const [method, path, body] of restricted) {
    const r = await call(method, path, tokens.admin, body);
    assert.notEqual(r.status, 403, `${method} ${path} must not be 403 for admin`);
    assert.notEqual(r.status, 401, `${method} ${path} must not be 401 for admin`);
  }
});

test('staff can still sell, look customers up and read stock', async () => {
  assert.equal((await call('GET', '/customers', tokens.staff)).status, 200);
  assert.equal((await call('GET', '/inventory', tokens.staff)).status, 200);
  assert.equal((await call('GET', '/sales', tokens.staff)).status, 200);
  const me = await call('GET', '/auth/me', tokens.staff);
  for (const p of ['stock:count', 'borrow:manage', 'ondemand:manage', 'inventory:transfer', 'credit:payment:record']) {
    assert.equal(me.body.permissions.includes(p), false, `staff must not hold ${p}`);
  }
  assert.equal(me.body.permissions.includes('sale:create'), true);
});

test('staff only ever see their own shops', async () => {
  const r = await call('GET', '/shops', tokens.staff);
  const names = (r.body.items || r.body).map((s) => s.name);
  assert.deepEqual(names, ['Main Shop']);
});
