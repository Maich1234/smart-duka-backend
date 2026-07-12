import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import RefreshToken from '../src/models/RefreshToken.js';
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
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
