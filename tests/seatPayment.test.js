import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import User from '../src/models/User.js';
import Subscription from '../src/models/Subscription.js';
import SubscriptionPayment from '../src/models/SubscriptionPayment.js';
import mpesaProvider from '../src/services/payments/mpesaProvider.js';
import { activateSeatPayment, cleanupFailedSeatPayment } from '../src/services/seatActivationService.js';
import { resolveStaffEmailSlot, initiateSeatPayment } from '../src/controllers/seatPaymentController.js';
import { createStaff } from '../src/controllers/staffController.js';

// Importing these registers mongoose schemas but never touches a DB; every
// static used below is mocked per-test, same convention as idempotency.test.js
// and refreshTokenService.test.js.

const starterPlan = {
  _id: 'plan-starter',
  slug: 'starter',
  billingType: 'per_staff',
  monthlyPrice: 210,
  maxStaff: 9,
  extraStaffPrice: 0,
  currency: 'KES',
};

const businessPlan = {
  _id: 'plan-business',
  slug: 'business',
  billingType: 'flat',
  monthlyPrice: 2000,
  maxStaff: 20,
  extraStaffPrice: 100,
  currency: 'KES',
};

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

beforeEach(() => {
  mock.restoreAll();
  process.env.SUBSCRIPTION_MPESA_CALLBACK_URL = 'https://example.test/subscriptions/mpesa/callback';
});

// ── seatActivationService ──────────────────────────────────────────────────

test('activateSeatPayment: activates the pending staff and snapshots staffCount, leaves period untouched', async () => {
  const staff = { isActive: false, save: async function () { this.saved = true; } };
  mock.method(User, 'findById', async () => staff);
  let updateArgs;
  mock.method(Subscription, 'updateOne', async (filter, update) => { updateArgs = { filter, update }; });

  await activateSeatPayment({ pendingStaff: 'staff-1', subscription: 'sub-1', staffCount: 5 });

  assert.equal(staff.isActive, true);
  assert.ok(staff.saved);
  assert.deepEqual(updateArgs.filter, { _id: 'sub-1' });
  assert.deepEqual(updateArgs.update, { $set: { staffCount: 5 } });
});

test('activateSeatPayment: no-ops when there is no pendingStaff', async () => {
  const findById = mock.method(User, 'findById', async () => { throw new Error('must not be called'); });
  await assert.doesNotReject(activateSeatPayment({ pendingStaff: null }));
  assert.equal(findById.mock.callCount(), 0);
});

test('activateSeatPayment: idempotent — no-ops when the staff is already active', async () => {
  const staff = { isActive: true, save: async () => { throw new Error('must not save again'); } };
  mock.method(User, 'findById', async () => staff);
  const updateOne = mock.method(Subscription, 'updateOne', async () => { throw new Error('must not touch subscription again'); });

  await assert.doesNotReject(activateSeatPayment({ pendingStaff: 'staff-1', subscription: 'sub-1', staffCount: 5 }));
  assert.equal(updateOne.mock.callCount(), 0);
});

test('cleanupFailedSeatPayment: deletes an inactive pending staff', async () => {
  let deleted = false;
  mock.method(User, 'findById', async () => ({ isActive: false, deleteOne: async () => { deleted = true; } }));

  await cleanupFailedSeatPayment({ purpose: 'seat_addition', pendingStaff: 'staff-1' });
  assert.ok(deleted);
});

test('cleanupFailedSeatPayment: no-ops for an already-active staff', async () => {
  mock.method(User, 'findById', async () => ({ isActive: true, deleteOne: async () => { throw new Error('must not delete an active staff'); } }));
  await assert.doesNotReject(cleanupFailedSeatPayment({ purpose: 'seat_addition', pendingStaff: 'staff-1' }));
});

test('cleanupFailedSeatPayment: no-ops for non-seat-addition payments', async () => {
  const findById = mock.method(User, 'findById', async () => { throw new Error('must not be called'); });
  await assert.doesNotReject(cleanupFailedSeatPayment({ purpose: 'subscription', pendingStaff: 'staff-1' }));
  assert.equal(findById.mock.callCount(), 0);
});

// ── resolveStaffEmailSlot ───────────────────────────────────────────────────

test('resolveStaffEmailSlot: no existing user → free', async () => {
  mock.method(User, 'findOne', async () => null);
  await assert.doesNotReject(resolveStaffEmailSlot('new@shop.test'));
});

test('resolveStaffEmailSlot: active existing user blocks with 400', async () => {
  mock.method(User, 'findOne', async () => ({ isActive: true }));
  await assert.rejects(resolveStaffEmailSlot('taken@shop.test'), (err) => err.status === 400);
});

test('resolveStaffEmailSlot: fresh in-flight seat payment blocks with 409 (no double charge)', async () => {
  mock.method(User, 'findOne', async () => ({ isActive: false, deleteOne: async () => { throw new Error('must not delete a live payment\'s staff'); } }));
  mock.method(SubscriptionPayment, 'findOne', () => ({ sort: async () => ({ status: 'pending', createdAt: new Date() }) }));

  await assert.rejects(resolveStaffEmailSlot('inflight@shop.test'), (err) => err.status === 409 && err.code === 'SEAT_PAYMENT_IN_PROGRESS');
});

test('resolveStaffEmailSlot: stale (>2min) pending payment frees the email', async () => {
  let deleted = false;
  mock.method(User, 'findOne', async () => ({ isActive: false, deleteOne: async () => { deleted = true; } }));
  mock.method(SubscriptionPayment, 'findOne', () => ({ sort: async () => ({ status: 'pending', createdAt: new Date(Date.now() - 5 * 60 * 1000) }) }));

  await assert.doesNotReject(resolveStaffEmailSlot('stale@shop.test'));
  assert.ok(deleted);
});

test('resolveStaffEmailSlot: terminal (failed/cancelled/timeout) payment frees the email', async () => {
  let deleted = false;
  mock.method(User, 'findOne', async () => ({ isActive: false, deleteOne: async () => { deleted = true; } }));
  mock.method(SubscriptionPayment, 'findOne', () => ({ sort: async () => ({ status: 'failed', createdAt: new Date() }) }));

  await assert.doesNotReject(resolveStaffEmailSlot('failed@shop.test'));
  assert.ok(deleted);
});

test('resolveStaffEmailSlot: orphaned inactive user with no payment record frees the email', async () => {
  let deleted = false;
  mock.method(User, 'findOne', async () => ({ isActive: false, deleteOne: async () => { deleted = true; } }));
  mock.method(SubscriptionPayment, 'findOne', () => ({ sort: async () => null }));

  await assert.doesNotReject(resolveStaffEmailSlot('orphan@shop.test'));
  assert.ok(deleted);
});

// ── createStaff — regression coverage for the billing bypass ──────────────

test('createStaff: seat within an already-paid flat tier activates immediately, no payment', async () => {
  mock.method(User, 'findOne', async () => null);
  const create = mock.method(User, 'create', async (doc) => ({ ...doc, toObject() { return { ...doc }; } }));
  mock.method(Subscription, 'findOne', () => ({ populate: () => ({ lean: async () => ({ plan: businessPlan, billingCycle: 'monthly' }) }) }));
  mock.method(User, 'countDocuments', async () => 5); // business is flat up to 20 seats — 5→6 doesn't cost more

  const req = { body: { name: 'Jane', email: 'jane@shop.test', password: 'secret1' }, user: { _id: 'owner-1', shop: { _id: 'shop-1' } } };
  const res = makeRes();
  await createStaff(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(create.mock.calls[0].arguments[0].isActive, true);
});

test('createStaff: seat that raises the bill is blocked — no unpaid seat can ever go active (regression for the billing bypass)', async () => {
  mock.method(User, 'findOne', async () => null);
  const create = mock.method(User, 'create', async () => { throw new Error('must not be called — this is the billing bypass'); });
  mock.method(Subscription, 'findOne', () => ({ populate: () => ({ lean: async () => ({ plan: starterPlan, billingCycle: 'monthly' }) }) }));
  mock.method(User, 'countDocuments', async () => 4); // starter is per-staff — any addition raises the bill

  const req = { body: { name: 'Jane', email: 'jane@shop.test', password: 'secret1' }, user: { _id: 'owner-1', shop: { _id: 'shop-1' } } };
  const res = makeRes();
  await createStaff(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'SEAT_PAYMENT_REQUIRED');
  assert.equal(create.mock.callCount(), 0);
});

// ── initiateSeatPayment ─────────────────────────────────────────────────────

test('initiateSeatPayment: bill no longer raised at charge-time → creates directly, no M-Pesa charge', async () => {
  mock.method(User, 'findOne', async () => null);
  const create = mock.method(User, 'create', async (doc) => ({ ...doc, toObject() { return { ...doc }; } }));
  mock.method(Subscription, 'findOne', () => ({ populate: async () => ({ _id: 'sub-1', plan: businessPlan, billingCycle: 'monthly' }) }));
  mock.method(User, 'countDocuments', async () => 5);
  const charge = mock.method(mpesaProvider, 'charge', async () => { throw new Error('must not be called'); });

  const req = { body: { name: 'Jane', email: 'jane@shop.test', password: 'secret1', phoneNumber: '0712345678' }, user: { _id: 'owner-1', shop: { _id: 'shop-1' } } };
  const res = makeRes();
  await initiateSeatPayment(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.mode, 'created');
  assert.equal(charge.mock.callCount(), 0);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(create.mock.calls[0].arguments[0].isActive, true);
});

test('initiateSeatPayment: bill raised → charges the delta and reserves the seat inactive', async () => {
  mock.method(User, 'findOne', async () => null);
  let createdDoc;
  mock.method(User, 'create', async (doc) => {
    createdDoc = doc;
    return { ...doc, _id: 'staff-1', toObject() { return { ...doc, _id: 'staff-1' }; }, deleteOne: async () => {} };
  });
  mock.method(Subscription, 'findOne', () => ({ populate: async () => ({ _id: 'sub-1', plan: starterPlan, billingCycle: 'monthly' }) }));
  mock.method(User, 'countDocuments', async () => 4); // starter per-staff: 4→5 costs one more seat (210)
  const charge = mock.method(mpesaProvider, 'charge', async ({ amount }) => {
    assert.equal(amount, 210);
    return { providerRef: 'ref-1', merchantRequestId: 'merch-1', phoneNumber: '254712345678' };
  });
  let paymentDoc;
  mock.method(SubscriptionPayment, 'create', async (doc) => { paymentDoc = doc; return { ...doc, _id: 'pay-1' }; });

  const req = { body: { name: 'Jane', email: 'jane@shop.test', password: 'secret1', phoneNumber: '0712345678' }, user: { _id: 'owner-1', shop: { _id: 'shop-1' } } };
  const res = makeRes();
  await initiateSeatPayment(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.mode, 'payment_pending');
  assert.equal(charge.mock.callCount(), 1);
  assert.equal(createdDoc.isActive, false);
  assert.equal(paymentDoc.purpose, 'seat_addition');
  assert.equal(paymentDoc.amount, 210);
  assert.equal(paymentDoc.pendingStaff, 'staff-1');
});

test('initiateSeatPayment: M-Pesa charge failure rolls back the reserved staff row', async () => {
  mock.method(User, 'findOne', async () => null);
  let deleted = false;
  mock.method(User, 'create', async (doc) => ({
    ...doc,
    _id: 'staff-2',
    toObject() { return { ...doc }; },
    deleteOne: async () => { deleted = true; },
  }));
  mock.method(Subscription, 'findOne', () => ({ populate: async () => ({ _id: 'sub-1', plan: starterPlan, billingCycle: 'monthly' }) }));
  mock.method(User, 'countDocuments', async () => 4);
  mock.method(mpesaProvider, 'charge', async () => { throw new Error('M-Pesa is down'); });

  const req = { body: { name: 'Jane', email: 'jane@shop.test', password: 'secret1', phoneNumber: '0712345678' }, user: { _id: 'owner-1', shop: { _id: 'shop-1' } } };
  const res = makeRes();
  await initiateSeatPayment(req, res);

  assert.equal(res.statusCode, 503);
  assert.ok(deleted, 'the reserved inactive staff row must be rolled back on charge failure');
});
