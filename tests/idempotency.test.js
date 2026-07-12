import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import idempotency from '../src/middlewares/idempotency.js';
import IdempotencyRecord from '../src/models/IdempotencyRecord.js';

// Importing the model registers the mongoose schema but never touches a DB;
// every static the middleware uses is mocked per-test below.

const USER_ID = 'user-1';

function makeReq(key) {
  return {
    headers: key ? { 'x-idempotency-key': key } : {},
    user: { _id: USER_ID },
    method: 'POST',
    originalUrl: '/api/v1/sales',
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    sentBody: undefined,
    sentVia: null,
    finishListeners: [],
    status(code) { this.statusCode = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    type() { return this; },
    json(body) { this.sentBody = body; this.sentVia = 'json'; return this; },
    send(body) { this.sentBody = body; this.sentVia = 'send'; return this; },
    on(event, fn) { if (event === 'finish') this.finishListeners.push(fn); },
  };
  return res;
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => mock.restoreAll());

test('no idempotency key → passes through untouched', async () => {
  const create = mock.method(IdempotencyRecord, 'create', async () => ({}));
  const req = makeReq(undefined);
  const res = makeRes();
  let nextCalled = false;

  await idempotency(req, res, () => { nextCalled = true; });

  assert.ok(nextCalled);
  assert.equal(create.mock.callCount(), 0);
});

test('first attempt: stores the response before sending it', async () => {
  mock.method(IdempotencyRecord, 'create', async () => ({}));
  const stored = [];
  mock.method(IdempotencyRecord, 'updateOne', (filter, update) => {
    stored.push({ filter, update });
    return { catch: () => Promise.resolve() };
  });

  const req = makeReq('key-1');
  const res = makeRes();
  let nextCalled = false;
  await idempotency(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled);

  // Handler responds as controllers do:
  res.status(201);
  res.json({ success: true, data: { invoiceNumber: 'INV-1' } });
  await flush();

  assert.equal(stored.length, 1);
  assert.equal(stored[0].update.statusCode, 201);
  assert.deepEqual(JSON.parse(stored[0].update.responseBody).data.invoiceNumber, 'INV-1');
  assert.equal(res.sentVia, 'json');
  assert.equal(res.sentBody.success, true);
});

test('5xx outcome deletes the stub so a retry can run fresh', async () => {
  mock.method(IdempotencyRecord, 'create', async () => ({}));
  const updates = [];
  mock.method(IdempotencyRecord, 'updateOne', () => {
    updates.push(1);
    return { catch: () => Promise.resolve() };
  });
  let deleted = false;
  mock.method(IdempotencyRecord, 'deleteOne', () => {
    deleted = true;
    return { catch: () => Promise.resolve() };
  });

  const req = makeReq('key-5xx');
  const res = makeRes();
  await idempotency(req, res, () => {});
  res.status(500);
  res.json({ success: false });
  await flush();

  assert.ok(deleted);
  assert.equal(updates.length, 0);
});

test('duplicate with a stored outcome replays it verbatim', async () => {
  mock.method(IdempotencyRecord, 'create', async () => {
    const err = new Error('dup');
    err.code = 11000;
    throw err;
  });
  mock.method(IdempotencyRecord, 'findOne', async () => ({
    statusCode: 201,
    responseBody: JSON.stringify({ success: true, data: { invoiceNumber: 'INV-1' } }),
  }));

  const req = makeReq('key-1');
  const res = makeRes();
  let nextCalled = false;
  await idempotency(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false, 'handler must NOT run again');
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers['X-Idempotent-Replay'], 'true');
  assert.equal(JSON.parse(res.sentBody).data.invoiceNumber, 'INV-1');
});

test('duplicate while first attempt is in flight → 425, handler not run', async () => {
  mock.method(IdempotencyRecord, 'create', async () => {
    const err = new Error('dup');
    err.code = 11000;
    throw err;
  });
  // Stub exists but has no outcome and is fresh (created seconds ago).
  mock.method(IdempotencyRecord, 'findOne', async () => ({
    statusCode: null,
    createdAt: new Date(),
  }));
  mock.method(IdempotencyRecord, 'findOneAndUpdate', async () => null); // not stale → no takeover

  const req = makeReq('key-inflight');
  const res = makeRes();
  let nextCalled = false;
  await idempotency(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 425);
});

test('stale in-flight stub (dead invocation) is taken over and re-executed', async () => {
  mock.method(IdempotencyRecord, 'create', async () => {
    const err = new Error('dup');
    err.code = 11000;
    throw err;
  });
  mock.method(IdempotencyRecord, 'findOne', async () => ({
    statusCode: null,
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
  }));
  mock.method(IdempotencyRecord, 'findOneAndUpdate', async () => ({ _id: 'claimed' }));

  const req = makeReq('key-stale');
  const res = makeRes();
  let nextCalled = false;
  await idempotency(req, res, () => { nextCalled = true; });

  assert.ok(nextCalled, 'takeover must let the retry execute');
});
