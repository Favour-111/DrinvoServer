import mongoose from 'mongoose';
import { env } from './env.js';
import { setTransactionSupport } from '../utils/atomic.js';

export async function connectDB() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongoUri, { autoIndex: true });

  // Transactions require a replica set or sharded cluster.
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  const supportsTx = Boolean(hello.setName || hello.msg === 'isdbgrid');
  setTransactionSupport(supportsTx);

  console.log(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
  if (!supportsTx) {
    console.warn(
      'MongoDB is running standalone, so transactions are unavailable. ' +
        'Multi-step writes will undo themselves on failure instead. ' +
        'Run `npm run db:dev` for a local replica set.'
    );
  }
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
