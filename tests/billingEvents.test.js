import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import BillingEvent from '../src/domains/billing/events/BillingEvent.js';
import { emitBillingEvent } from '../src/domains/billing/events/emit.js';
import { dispatchBillingEvent } from '../src/domains/billing/events/dispatch.js';
import { HANDLERS_BY_TYPE } from '../src/domains/billing/events/handlers/registry.js';
import { Receiver } from '@upstash/qstash';

// Importing the model registers the mongoose schema but never touches a DB;
// every static used below is mocked per-test, same convention as
// seatPayment.test.js. QSTASH_TOKEN is intentionally never set in this test
// process (no test imports app.js, which is the only place dotenv loads),
// so publishToQStash always takes its "not configured" early-return path —
// no real network call is ever made by these tests.

const TYPE = 'subscription.payment_succeeded';
const originalHandlers = HANDLERS_BY_TYPE[TYPE];

beforeEach(() => {
  mock.restoreAll();
});

afterEach(() => {
  HANDLERS_BY_TYPE[TYPE] = originalHandlers;
});

// ── emitBillingEvent ─────────────────────────────────────────────────────────

test('emitBillingEvent: creates one outbox row seeded with pending entries for every registered handler', async () => {
  HANDLERS_BY_TYPE[TYPE] = [{ key: 'email', run: async () => {} }, { key: 'push', run: async () => {} }];
  let created;
  mock.method(BillingEvent, 'create', async (doc) => { created = doc; return { ...doc, _id: 'evt-1' }; });

  await emitBillingEvent({ type: TYPE, paymentId: 'pay-1', shopId: 'shop-1', payload: { amount: 500 } });

  assert.equal(created.type, TYPE);
  assert.deepEqual(created.handlers, [{ key: 'email', status: 'pending' }, { key: 'push', status: 'pending' }]);
});

test('emitBillingEvent: a duplicate (payment, type) is idempotent — returns the existing row instead of throwing', async () => {
  const dupErr = Object.assign(new Error('duplicate key'), { code: 11000 });
  mock.method(BillingEvent, 'create', async () => { throw dupErr; });
  const existing = { _id: 'evt-existing' };
  mock.method(BillingEvent, 'findOne', async () => existing);

  const result = await emitBillingEvent({ type: TYPE, paymentId: 'pay-1', shopId: 'shop-1', payload: {} });
  assert.equal(result, existing);
});

test('emitBillingEvent: a non-duplicate create error still throws', async () => {
  mock.method(BillingEvent, 'create', async () => { throw new Error('mongo is down'); });
  await assert.rejects(emitBillingEvent({ type: TYPE, paymentId: 'pay-1', shopId: 'shop-1', payload: {} }), /mongo is down/);
});

// ── dispatchBillingEvent ─────────────────────────────────────────────────────

function fakeEvent(overrides = {}) {
  return {
    _id: 'evt-1',
    type: TYPE,
    shop: 'shop-1',
    dispatchAttempts: 1,
    handlers: [{ key: 'email', status: 'pending', attempts: 0 }, { key: 'push', status: 'pending', attempts: 0 }],
    save: async function () { this.saved = true; },
    ...overrides,
  };
}

test('dispatchBillingEvent: no claimable row (already completed/claimed) is a no-op, reports the existing status', async () => {
  mock.method(BillingEvent, 'findOneAndUpdate', async () => null);
  mock.method(BillingEvent, 'findById', async () => ({ status: 'completed' }));

  const { status } = await dispatchBillingEvent('evt-1');
  assert.equal(status, 'completed');
});

test('dispatchBillingEvent: every handler succeeding marks the event completed', async () => {
  HANDLERS_BY_TYPE[TYPE] = [
    { key: 'email', run: async () => {} },
    { key: 'push', run: async () => {} },
  ];
  const event = fakeEvent();
  mock.method(BillingEvent, 'findOneAndUpdate', async () => event);

  const { status } = await dispatchBillingEvent('evt-1');

  assert.equal(status, 'completed');
  assert.ok(event.handlers.every((h) => h.status === 'done'));
  assert.equal(event.claimedAt, null);
});

test('dispatchBillingEvent: one handler failing does not block or lose the others — only the failed one is retried next time', async () => {
  HANDLERS_BY_TYPE[TYPE] = [
    { key: 'email', run: async () => { throw new Error('SMTP down'); } },
    { key: 'push', run: async () => {} },
  ];
  const event = fakeEvent();
  mock.method(BillingEvent, 'findOneAndUpdate', async () => event);

  const { status } = await dispatchBillingEvent('evt-1');

  assert.equal(status, 'pending', 'a partially-failed event must stay pending for retry, not be lost');
  const email = event.handlers.find((h) => h.key === 'email');
  const push = event.handlers.find((h) => h.key === 'push');
  assert.equal(email.status, 'failed');
  assert.match(email.lastError, /SMTP down/);
  assert.equal(push.status, 'done', 'the succeeding handler must not be reverted by the failing one');
});

test('dispatchBillingEvent: a handler already marked done is not re-run on a retry', async () => {
  let pushRunCount = 0;
  HANDLERS_BY_TYPE[TYPE] = [
    { key: 'email', run: async () => { throw new Error('still down'); } },
    { key: 'push', run: async () => { pushRunCount += 1; } },
  ];
  const event = fakeEvent({
    handlers: [
      { key: 'email', status: 'pending', attempts: 1 },
      { key: 'push', status: 'done', attempts: 1, completedAt: new Date() },
    ],
  });
  mock.method(BillingEvent, 'findOneAndUpdate', async () => event);

  await dispatchBillingEvent('evt-1');

  assert.equal(pushRunCount, 0, 'an already-done handler must not run again');
});

test('dispatchBillingEvent: exhausting the attempt cap moves a still-failing event to dead_letter', async () => {
  HANDLERS_BY_TYPE[TYPE] = [{ key: 'email', run: async () => { throw new Error('permanently broken'); } }];
  const event = fakeEvent({ dispatchAttempts: 10, handlers: [{ key: 'email', status: 'pending', attempts: 9 }] });
  mock.method(BillingEvent, 'findOneAndUpdate', async () => event);

  const { status } = await dispatchBillingEvent('evt-1');
  assert.equal(status, 'dead_letter');
});

test('dispatchBillingEvent: a handler no longer registered for this type is skipped, not stuck forever', async () => {
  HANDLERS_BY_TYPE[TYPE] = []; // 'email' was removed from the registry
  const event = fakeEvent({ handlers: [{ key: 'email', status: 'pending', attempts: 0 }] });
  mock.method(BillingEvent, 'findOneAndUpdate', async () => event);

  const { status } = await dispatchBillingEvent('evt-1');

  assert.equal(status, 'completed');
  assert.equal(event.handlers[0].status, 'skipped');
});

// ── QStash Receiver.verify — pure JWT verification, no network call ─────────

const CURRENT_KEY = 'test-current-signing-key';
const NEXT_KEY = 'test-next-signing-key';
const CALLBACK_URL = 'https://smart-duka-backend-iota.vercel.app/api/v1/billing-events/dispatch';

async function signQStashRequest({ body, url = CALLBACK_URL, key = CURRENT_KEY }) {
  const bodyHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const hashB64 = Buffer.from(bodyHash).toString('base64url');
  return new SignJWT({ iss: 'Upstash', sub: url, body: hashB64 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(key));
}

test('Receiver.verify: a genuinely QStash-signed request (current key) verifies true', async () => {
  const receiver = new Receiver({ currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY });
  const body = JSON.stringify({ eventId: 'evt-1' });
  const signature = await signQStashRequest({ body });

  const valid = await receiver.verify({ signature, body, url: CALLBACK_URL });
  assert.equal(valid, true);
});

test('Receiver.verify: a request signed with the rotated next key also verifies (key-rotation support)', async () => {
  const receiver = new Receiver({ currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY });
  const body = JSON.stringify({ eventId: 'evt-1' });
  const signature = await signQStashRequest({ body, key: NEXT_KEY });

  const valid = await receiver.verify({ signature, body, url: CALLBACK_URL });
  assert.equal(valid, true);
});

test('Receiver.verify: a forged signature (wrong key) throws rather than validating', async () => {
  const receiver = new Receiver({ currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY });
  const body = JSON.stringify({ eventId: 'evt-1' });
  const signature = await signQStashRequest({ body, key: 'attacker-controlled-key' });

  await assert.rejects(receiver.verify({ signature, body, url: CALLBACK_URL }));
});

test('Receiver.verify: a tampered body (valid signature, different bytes) throws — the hash bakes the body in', async () => {
  const receiver = new Receiver({ currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY });
  const originalBody = JSON.stringify({ eventId: 'evt-1' });
  const signature = await signQStashRequest({ body: originalBody });

  const tamperedBody = JSON.stringify({ eventId: 'evt-attacker-chosen' });
  await assert.rejects(receiver.verify({ signature, body: tamperedBody, url: CALLBACK_URL }));
});

test('Receiver.verify: a signature minted for a different URL throws — the subject is checked, not just the signature', async () => {
  const receiver = new Receiver({ currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY });
  const body = JSON.stringify({ eventId: 'evt-1' });
  const signature = await signQStashRequest({ body, url: 'https://attacker.example/dispatch' });

  await assert.rejects(receiver.verify({ signature, body, url: CALLBACK_URL }));
});
