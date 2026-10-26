import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/unused';
process.env.JWT_SECRET ||= 'test-secret-test-secret-test-secret-123';

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

/**
 * Starts a throwaway single-node MongoDB replica set (so real transactions run, like production)
 * in a temp directory and connects mongoose to it. Nothing here touches the dev/prod database.
 */
export async function startTestDb() {
  const { default: mongoose } = await import('mongoose');
  const { setTransactionSupport } = await import('../src/utils/atomic.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'drinvo-test-'));
  const port = await freePort();
  const proc = spawn('mongod', ['--replSet', 'rs0', '--port', String(port), '--dbpath', dir, '--bind_ip', '127.0.0.1', '--quiet'], { stdio: 'ignore' });
  const uri = `mongodb://127.0.0.1:${port}/test?replicaSet=rs0`;

  // Wait for mongod, then initiate the replica set once
  let direct;
  for (let i = 0; i < 100; i += 1) {
    try {
      direct = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/admin?directConnection=true`, { serverSelectionTimeoutMS: 500 }).asPromise();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!direct) throw new Error('mongod did not start (is MongoDB installed?)');
  await direct.db.admin().command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
  await direct.close();

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  for (let i = 0; i < 100; i += 1) {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (hello.isWritablePrimary) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  setTransactionSupport(true);
  // Models must have their collections/indexes before the first transaction (Mongo can't create them inside one)
  await Promise.all(Object.values(mongoose.models).map((m) => m.createCollection().catch(() => {})));
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

  return {
    mongoose,
    async stop() {
      await mongoose.disconnect();
      proc.kill('SIGTERM');
      await new Promise((r) => proc.once('exit', r));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A business with two shops, an admin, a staff member and a supplier, plus ready-made request contexts. */
export async function seedBusiness() {
  const m = await import('../src/models/index.js');
  const business = await m.Business.create({ name: 'Test Drinks' });
  const [shopA, shopB] = await m.Shop.create([
    { businessId: business._id, name: 'Main Shop' },
    { businessId: business._id, name: 'Branch Shop' },
  ]);
  const admin = await m.User.create({ businessId: business._id, shopIds: [shopA._id, shopB._id], name: 'Admin', email: 'admin@test.dev', password: 'Password123!', role: 'ADMIN' });
  const staff = await m.User.create({ businessId: business._id, shopIds: [shopA._id], name: 'Staff', email: 'staff@test.dev', password: 'Password123!', role: 'STAFF' });
  const supplier = await m.Supplier.create({ businessId: business._id, name: 'Mini Supplies', contacts: [{ name: 'Ada' }] });
  const ctxFor = (user, shop) => ({
    user: user.toObject(),
    userId: user._id,
    businessId: business._id,
    business: business.toObject(),
    shopId: shop._id,
    shop: shop.toObject(),
    touchedVariantIds: new Set(),
  });
  return { business, shopA, shopB, admin, staff, supplier, adminA: () => ctxFor(admin, shopA), adminB: () => ctxFor(admin, shopB), staffA: () => ctxFor(staff, shopA) };
}
