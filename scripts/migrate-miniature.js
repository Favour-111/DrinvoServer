/**
 * Optional, idempotent, non-destructive backfill for the Miniature packaging feature.
 *
 * The app already treats a missing packagingType as STANDARD, so running this is not required for
 * correctness. It just writes the explicit default onto older documents so the data is uniform
 * (and queryable with `{ packagingType: 'STANDARD' }`). It only fills fields that are absent: it never
 * changes stock, prices, conversions or any value that is already set.
 *
 *   npm run migrate:miniature -- --dry-run   # report what would change
 *   npm run migrate:miniature                # apply
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { Product, ProductVariant, SaleItem } from '../src/models/index.js';

const dryRun = process.argv.includes('--dry-run');

async function backfill(label, Model, filter, set) {
  const missing = await Model.collection.countDocuments(filter);
  if (!dryRun && missing) await Model.collection.updateMany(filter, { $set: set });
  console.log(`${dryRun ? 'Would update' : 'Updated'} ${missing} ${label}`);
}

await mongoose.connect(env.mongoUri);
await backfill('products (packagingType → STANDARD)', Product, { packagingType: { $exists: false } }, { packagingType: 'STANDARD' });
await backfill('sale lines (packagingType → STANDARD)', SaleItem, { packagingType: { $exists: false } }, { packagingType: 'STANDARD' });
await backfill('product sizes (unitCosts → none set)', ProductVariant, { unitCosts: { $exists: false } }, { unitCosts: { pack: 0, carton: 0, crate: 0 } });
await mongoose.disconnect();
