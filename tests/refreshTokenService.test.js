import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import RefreshToken from '../src/models/RefreshToken.js';
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllSessions,
  RefreshTokenError,
} from '../src/services/refreshTokenService.js';

beforeEach(() => mock.restoreAll());

test('issueRefreshToken stores only the hash, never the raw token', async () => {
  let created;
  mock.method(RefreshToken, 'create', async (doc) => { created = doc; return doc; });

  const raw = await issueRefreshToken('user-1');

  assert.equal(raw.length, 96); // 48 random bytes as hex
  assert.notEqual(created.tokenHash, raw);
  assert.equal(created.tokenHash, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.ok(created.expiresAt > new Date());
});

test('rotate: valid token is revoked and replaced', async () => {
  mock.method(RefreshToken, 'findOneAndUpdate', async (filter) => {
    assert.equal(filter.revokedAt, null);
    return { user: 'user-1' };
  });
  mock.method(RefreshToken, 'create', async (doc) => doc);

  const { userId, refreshToken } = await rotateRefreshToken('a'.repeat(96));
  assert.equal(userId, 'user-1');
  assert.equal(refreshToken.length, 96);
});

test('rotate: replayed (already revoked) token kills the whole session family', async () => {
  mock.method(RefreshToken, 'findOneAndUpdate', async () => null);
  mock.method(RefreshToken, 'findOne', async () => ({ user: 'user-1', revokedAt: new Date() }));
  let familyRevoked = false;
  mock.method(RefreshToken, 'updateMany', async (filter) => {
    assert.equal(filter.user, 'user-1');
    familyRevoked = true;
    return {};
  });

  await assert.rejects(rotateRefreshToken('b'.repeat(96)), RefreshTokenError);
  assert.ok(familyRevoked);
});

test('rotate: replay of a token revoked for an intentional reason (e.g. superseded by a new device login) does NOT cascade-revoke the new session', async () => {
  mock.method(RefreshToken, 'findOneAndUpdate', async () => null);
  mock.method(RefreshToken, 'findOne', async () => ({
    user: 'user-1',
    revokedAt: new Date(),
    revokedReason: 'superseded_by_new_device',
  }));
  const updateMany = mock.method(RefreshToken, 'updateMany', async () => ({}));

  await assert.rejects(rotateRefreshToken('d'.repeat(96)), (err) => {
    assert.ok(err instanceof RefreshTokenError);
    assert.equal(err.code, 'SESSION_REVOKED_ELSEWHERE');
    return true;
  });
  // The whole point of the fix: a stale device retrying its dead refresh
  // token after being superseded must not nuke the device that superseded it.
  assert.equal(updateMany.mock.callCount(), 0);
});

test('rotate: replay of an organically-rotated token still cascades (real theft signal)', async () => {
  mock.method(RefreshToken, 'findOneAndUpdate', async () => null);
  mock.method(RefreshToken, 'findOne', async () => ({
    user: 'user-1',
    revokedAt: new Date(),
    revokedReason: 'rotated',
  }));
  let familyRevoked = false;
  mock.method(RefreshToken, 'updateMany', async (filter, update) => {
    assert.equal(filter.user, 'user-1');
    assert.equal(update.$set.revokedReason, 'token_reuse_detected');
    familyRevoked = true;
    return {};
  });

  await assert.rejects(rotateRefreshToken('e'.repeat(96)), RefreshTokenError);
  assert.ok(familyRevoked);
});

test('rotate: unknown token rejects without touching other sessions', async () => {
  mock.method(RefreshToken, 'findOneAndUpdate', async () => null);
  mock.method(RefreshToken, 'findOne', async () => null);
  const updateMany = mock.method(RefreshToken, 'updateMany', async () => ({}));

  await assert.rejects(rotateRefreshToken('c'.repeat(96)), RefreshTokenError);
  assert.equal(updateMany.mock.callCount(), 0);
});

test('rotate: garbage input rejects fast', async () => {
  await assert.rejects(rotateRefreshToken(undefined), RefreshTokenError);
  await assert.rejects(rotateRefreshToken('x'.repeat(500)), RefreshTokenError);
});

test('revoke: ignores unknown tokens quietly', async () => {
  mock.method(RefreshToken, 'updateOne', async () => ({ matchedCount: 0 }));
  await assert.doesNotReject(revokeRefreshToken('whatever'));
  await assert.doesNotReject(revokeRefreshToken(undefined));
});

test('revokeAllSessions: sets revokedAt and revokedReason together for every active session', async () => {
  let capturedFilter;
  let capturedUpdate;
  mock.method(RefreshToken, 'updateMany', async (filter, update) => {
    capturedFilter = filter;
    capturedUpdate = update;
    return {};
  });

  await revokeAllSessions('user-1', 'admin_force_logout');

  assert.deepEqual(capturedFilter, { user: 'user-1', revokedAt: null });
  assert.equal(capturedUpdate.$set.revokedReason, 'admin_force_logout');
  assert.ok(capturedUpdate.$set.revokedAt instanceof Date);
});
