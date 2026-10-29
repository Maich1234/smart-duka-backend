import { presentMutationReplay } from '../services/mutationReplayVisibility.js';
import IdempotencyRecord from '../models/IdempotencyRecord.js';

// Replays the stored response for retried mutations carrying the same
// idempotency key. Mount AFTER `protect` (needs req.user) on any route the
// mobile offline queue can retry: without this, a request that committed but
// timed out on the response gets re-sent and executes twice (duplicate sale,
// double stock decrement).
//
// Flow:
//   1. No key header → pass through (backwards compatible).
//   2. Atomically insert a stub record. If the insert conflicts, a previous
//      attempt owns this key:
//        • finished → replay its stored result with current response visibility
//        • still in flight → 425 so the client retries shortly (the offline
//          queue treats 425 as transient, never as a permanent failure)
//   3. Wrap res.json to persist the outcome. 5xx outcomes are NOT stored —
//      the stub is deleted so the retry gets a fresh attempt.
const idempotency = async (req, res, next) => {
  const key = req.headers['x-idempotency-key'] ?? req.headers['idempotency-key'];
  if (!key || typeof key !== 'string' || key.length > 128 || !req.user) return next();

  try {
    await IdempotencyRecord.create({
      key,
      user: req.user._id,
      method: req.method,
      path: req.originalUrl,
    });
  } catch (err) {
    if (err.code !== 11000) return next(err);
    const existing = await IdempotencyRecord.findOne({ user: req.user._id, key });
    if (existing && (existing.method !== req.method || existing.path !== req.originalUrl)) {
      return res.status(409).json({ success: false, code: 'IDEMPOTENCY_KEY_REUSED', message: 'This request key belongs to a different action. Use the original action when retrying.' });
    }
    if (existing?.statusCode) {
      let body;
      try { body = JSON.parse(existing.responseBody ?? '{}'); }
      catch { return res.status(503).json({ success: false, message: 'The saved result could not be restored. Check the original action before trying again.' }); }
      const savedShop = body?.data?.shop ?? body?.data?.transaction?.shop;
      if (savedShop && String(savedShop._id ?? savedShop) !== String(req.user.shop._id ?? req.user.shop)) {
        return res.status(403).json({ success: false, message: 'This saved result belongs to a different shop.' });
      }
      res.set('X-Idempotent-Replay', 'true');
      return res.status(existing.statusCode).json(presentMutationReplay(body, req));
    }
    // Stub with no outcome: either the first attempt is still running, or its
    // invocation died mid-request (serverless kill). Anything older than 2 min
    // outlived every possible execution window — claim it and retry fresh.
    const STALE_MS = 2 * 60 * 1000;
    const claimed = await IdempotencyRecord.findOneAndUpdate(
      { user: req.user._id, key, statusCode: null, createdAt: { $lt: new Date(Date.now() - STALE_MS) } },
      { $set: { createdAt: new Date() } }
    );
    if (!claimed) {
      // First attempt genuinely still running — tell the client to come back.
      return res.status(425).json({
        success: false,
        message: 'This request is already being processed. Please wait a moment.',
      });
    }
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const status = res.statusCode;
    if (status >= 500) {
      // Transient server failure — allow a clean retry under the same key.
      IdempotencyRecord.deleteOne({ user: req.user._id, key }).catch(() => {});
      return originalJson(body);
    }
    // 2xx–4xx is the definitive outcome for this key; persist it BEFORE the
    // response goes out. If the runtime froze right after replying but before
    // an async store completed, the sale would have committed with no replay
    // record — and the stale-stub takeover would re-execute it.
    IdempotencyRecord.updateOne(
      { user: req.user._id, key },
      { statusCode: status, responseBody: JSON.stringify(body) }
    )
      .catch(() => {})
      .then(() => originalJson(body));
    return res;
  };

  // If the handler crashes before responding (process-level failure), the
  // error handler responds without res.json interception in some paths —
  // clean the stub when the response closes with a 5xx and no stored body.
  res.on('finish', () => {
    if (res.statusCode >= 500) {
      IdempotencyRecord.deleteOne({ user: req.user._id, key, statusCode: null }).catch(() => {});
    }
  });

  next();
};

export default idempotency;
