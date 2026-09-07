import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import OAuthTicket from '../src/models/OAuthTicket.js';
import { issueTicket, claimTicket, OAuthTicketError } from '../src/services/oauthTicketService.js';

beforeEach(() => mock.restoreAll());

test('issueTicket stores only the hash, never the raw ticket', async () => {
  let created;
  mock.method(OAuthTicket, 'create', async (doc) => { created = doc; return doc; });

  const raw = await issueTicket({ kind: 'pending_signup', payload: { email: 'a@b.com' }, ttlMs: 60000 });

  assert.equal(raw.length, 64); // 32 random bytes as hex
  assert.notEqual(created.tokenHash, raw);
  assert.equal(created.tokenHash, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.equal(created.kind, 'pending_signup');
  assert.ok(created.expiresAt > new Date());
});

test('claimTicket: valid unclaimed ticket returns its payload', async () => {
  const payload = { userId: 'user-1' };
  mock.method(OAuthTicket, 'findOneAndUpdate', async (filter) => {
    assert.equal(filter.kind, 'mobile_exchange');
    assert.equal(filter.claimedAt, null);
    return { payload };
  });

  const result = await claimTicket('a'.repeat(64), 'mobile_exchange');
  assert.deepEqual(result, payload);
});

test('claimTicket: a second claim of the same ticket fails (no double redemption)', async () => {
  // The atomic findOneAndUpdate only matches claimedAt:null — once claimed,
  // the second caller's query simply finds nothing, exactly like
  // rotateRefreshToken's already-revoked-token case.
  mock.method(OAuthTicket, 'findOneAndUpdate', async () => null);

  await assert.rejects(claimTicket('a'.repeat(64), 'mobile_exchange'), OAuthTicketError);
});

test('claimTicket: wrong kind never redeems a ticket issued for the other kind', async () => {
  const findOneAndUpdate = mock.method(OAuthTicket, 'findOneAndUpdate', async (filter) => {
    // Simulates the DB: a ticket exists but was issued as 'pending_signup',
    // so a query scoped to 'mobile_exchange' must not match it.
    if (filter.kind !== 'pending_signup') return null;
    return { payload: { email: 'a@b.com' } };
  });

  await assert.rejects(claimTicket('a'.repeat(64), 'mobile_exchange'), OAuthTicketError);
  assert.equal(findOneAndUpdate.mock.callCount(), 1);
});

test('claimTicket: garbage input rejects fast without hitting the database', async () => {
  const findOneAndUpdate = mock.method(OAuthTicket, 'findOneAndUpdate', async () => null);

  await assert.rejects(claimTicket(undefined, 'pending_signup'), OAuthTicketError);
  await assert.rejects(claimTicket('x'.repeat(500), 'pending_signup'), OAuthTicketError);
  assert.equal(findOneAndUpdate.mock.callCount(), 0);
});
