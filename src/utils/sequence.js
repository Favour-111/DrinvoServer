import { Counter } from '../models/index.js';

/**
 * Atomically increments and returns the next number for `key`.
 * Runs inside the caller's transaction when there is one; numbers may skip
 * if a transaction aborts, which is acceptable for receipts.
 */
export async function nextSequence(key, tx) {
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session: tx?.session ?? null }
  );
  return doc.seq;
}

export const formatNumber = (prefix, n, width = 6) => `${prefix}${String(n).padStart(width, '0')}`;
