import crypto from 'crypto';
import RefreshToken from '../models/RefreshToken.js';

// 30-day sliding window: every rotation issues a fresh 30-day token, so an
// actively-used shop device stays signed in indefinitely while an abandoned
// one expires.
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// Revocations recorded with one of these reasons were deliberate — a stale
// device retrying its refresh after one of these is an expected race, not an
// attack. Anything else (null, or 'rotated' from a normal same-device
// rotation) means the presented token was already consumed once before, i.e.
// a genuine replay.
const INTENTIONAL_REVOCATION_REASONS = new Set([
  'manual_logout',
  'superseded_by_new_device',
  'admin_force_logout',
  'password_change',
]);

/** Issues a new refresh token for a user. Returns the RAW token (only time it exists in plaintext). */
export const issueRefreshToken = async (userId, device = {}) => {
  const raw = crypto.randomBytes(48).toString('hex');
  await RefreshToken.create({
    user: userId,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    deviceId: device.deviceId ?? null,
    deviceName: device.deviceName ?? null,
    platform: device.platform ?? null,
  });
  return raw;
};

export class RefreshTokenError extends Error {
  constructor(message, code = 'SESSION_EXPIRED') {
    super(message);
    this.status = 401;
    this.code = code;
  }
}

/**
 * Validates + rotates a refresh token: the presented token is revoked and a
 * replacement issued atomically enough for the single-client mobile flow.
 * Reuse of an already-revoked token usually means the token leaked — but it
 * can also mean a device was deliberately superseded (new login elsewhere,
 * admin force-logout, password change) and is now retrying its old refresh
 * token unaware it's dead. Only the former is treated as theft.
 */
export const rotateRefreshToken = async (raw) => {
  if (!raw || typeof raw !== 'string' || raw.length > 256) {
    throw new RefreshTokenError('Invalid refresh token');
  }
  const tokenHash = hashToken(raw);
  const now = new Date();

  // Atomic claim: only one concurrent request can rotate a given token.
  const doc = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { revokedAt: now, revokedReason: 'rotated' } }
  );

  if (!doc) {
    const spent = await RefreshToken.findOne({ tokenHash });
    if (spent) {
      if (INTENTIONAL_REVOCATION_REASONS.has(spent.revokedReason)) {
        // Expected: this device was deliberately signed out elsewhere.
        // Don't touch any other session — in particular, not the new one
        // that superseded it.
        throw new RefreshTokenError('Session expired. Please sign in again.', 'SESSION_REVOKED_ELSEWHERE');
      }
      // Replay of an organically-rotated (or already-replayed) token — kill
      // the whole session family.
      await RefreshToken.updateMany(
        { user: spent.user, revokedAt: null },
        { $set: { revokedAt: now, revokedReason: 'token_reuse_detected' } }
      );
    }
    throw new RefreshTokenError('Session expired. Please sign in again.');
  }

  const newRaw = await issueRefreshToken(doc.user, {
    deviceId: doc.deviceId,
    deviceName: doc.deviceName,
    platform: doc.platform,
  });
  return { userId: doc.user, refreshToken: newRaw };
};

/** Best-effort revocation on logout. Unknown tokens are ignored. */
export const revokeRefreshToken = async (raw, reason = 'manual_logout') => {
  if (!raw || typeof raw !== 'string') return;
  await RefreshToken.updateOne(
    { tokenHash: hashToken(raw), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
};

/**
 * Bulk-revokes every active session for a user (password change, admin
 * force-logout, or a staff login superseding every other device). Reason is
 * always set alongside revokedAt so a stale device's next rotate attempt can
 * tell this was intentional (see rotateRefreshToken).
 */
export const revokeAllSessions = async (userId, reason) => {
  await RefreshToken.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
};
