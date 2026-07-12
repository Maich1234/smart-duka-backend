import mongoose from 'mongoose';

// One record per (user, idempotency key). Created as a stub when a keyed
// mutation starts, then filled with the response so retries of the same
// logical operation (offline queue, network flaps) replay the original
// outcome instead of re-executing it — e.g. a sale that committed but whose
// response was lost to a timeout must not decrement stock twice.
const idempotencyRecordSchema = new mongoose.Schema({
  key: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  method: { type: String, required: true },
  path: { type: String, required: true },
  // null until the first attempt finishes — signals "in flight" to duplicates
  statusCode: { type: Number, default: null },
  responseBody: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

idempotencyRecordSchema.index({ user: 1, key: 1 }, { unique: true });
// Records only need to outlive the client's retry window (offline queue slow
// cadence is 5 min; devices offline for days re-enqueue with the same key, so
// keep 72 h of history).
idempotencyRecordSchema.index({ createdAt: 1 }, { expireAfterSeconds: 72 * 60 * 60 });

export default mongoose.model('IdempotencyRecord', idempotencyRecordSchema);
