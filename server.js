import { env } from './src/config/env.js';
import { connectDB, disconnectDB } from './src/config/db.js';
import { createApp } from './src/app.js';
import { attachStockSocket } from './src/realtime/stockHub.js';

async function main() {
  await connectDB();
  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`Drinvo API listening on http://localhost:${env.port}`);
  });
  attachStockSocket(server);

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
