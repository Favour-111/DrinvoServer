import mongoose from 'mongoose';

let transactionsSupported = false;

export function setTransactionSupport(value) {
  transactionsSupported = value;
}

export function supportsTransactions() {
  return transactionsSupported;
}

/**
 * Runs `work(tx)` atomically.
 *
 * With a replica set, `work` runs inside a MongoDB transaction and `tx.session`
 * must be passed to every read/write. On a standalone server there is no
 * session; instead each write registers an undo step with `tx.undo(fn)`, and
 * those steps run in reverse order if `work` throws.
 */
export async function runAtomic(work) {
  if (transactionsSupported) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await work({ session, undo: () => {} });
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  const undoSteps = [];
  const tx = { session: null, undo: (fn) => undoSteps.push(fn) };
  try {
    return await work(tx);
  } catch (err) {
    for (const step of undoSteps.reverse()) {
      try {
        await step();
      } catch (undoErr) {
        console.error('Undo step failed:', undoErr);
      }
    }
    throw err;
  }
}

/** Creates one document within `tx`, registering its removal as an undo step. */
export async function createDoc(Model, data, tx) {
  const [doc] = await Model.create([data], { session: tx.session });
  tx.undo(() => Model.deleteOne({ _id: doc._id }));
  return doc;
}

/** Creates many documents within `tx`. */
export async function createDocs(Model, list, tx) {
  if (!list.length) return [];
  const docs = await Model.create(list, { session: tx.session, ordered: true });
  tx.undo(() => Model.deleteMany({ _id: { $in: docs.map((d) => d._id) } }));
  return docs;
}

/** Applies `update` to one document, registering a restore of the given fields. */
export async function updateDoc(Model, doc, update, tx) {
  const before = {};
  for (const key of Object.keys(update.$set || {})) before[key] = doc.get ? doc.get(key) : doc[key];
  for (const key of Object.keys(update.$inc || {})) before[key] = doc.get ? doc.get(key) : doc[key];
  const res = await Model.findOneAndUpdate({ _id: doc._id }, update, { new: true, session: tx.session });
  tx.undo(() => Model.updateOne({ _id: doc._id }, { $set: before }));
  return res;
}
