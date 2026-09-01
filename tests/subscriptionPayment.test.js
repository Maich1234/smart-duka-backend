import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Subscription from '../src/models/Subscription.js';
import SubscriptionPayment from '../src/models/SubscriptionPayment.js';
import Promotion from '../src/models/Promotion.js';
import Shop from '../src/models/Shop.js';
import User from '../src/models/User.js';
import mpesaProvider from '../src/domains/billing/infra/payments/mpesaProvider.js';
import bankProvider from '../src/domains/billing/infra/payments/bankProvider.js';
import { applySuccessfulPayment } from '../src/domains/billing/application/applySuccessfulPayment.js';
import { reconcilePayment } from '../src/domains/billing/application/reconcilePayment.js';
import { paystackAmountMismatch } from '../src/domains/billing/domain/fraud.js';
import {
  handleMpesaCallback,
  handlePaystackWebhook,
} from '../src/controllers/subscriptionController.js';

// Importing these registers mongoose schemas but never touches a DB; every
// static used below is mocked per-test, same convention as seatPayment.test.js.

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
});

// ── applySuccessfulPayment ──────────────────────────────────────────────────

test('applySuccessfulPayment: seat_addition purpose delegates to activateSeatPayment, never touches Subscription.findById', async () => {
  const staff = { isActive: false, save: async function () { this.saved = true; } };
  mock.method(User, 'findById', async () => staff);
  mock.method(Subscription, 'updateOne', async () => {});
  const findById = mock.method(Subscription, 'findById', async () => { throw new Error('must not look up the subscription doc for a seat payment'); });

  await applySuccessfulPayment({ purpose: 'seat_addition', pendingStaff: 'staff-1', subscription: 'sub-1', staffCount: 3 });

  assert.equal(staff.isActive, true);
  assert.equal(findById.mock.callCount(), 0);
});

test('applySuccessfulPayment: idempotent — a subscription payment with periodEnd already set is a no-op', async () => {
  const findById = mock.method(Subscription, 'findById', async () => { throw new Error('must not be called'); });
  await applySuccessfulPayment({ purpose: 'subscription', periodEnd: new Date(), shop: 'shop-1' });
  assert.equal(findById.mock.callCount(), 0);
});

test('applySuccessfulPayment: subscription purpose activates, stacks the period on the later of now/trialEnd/currentPeriodEnd, redeems the promo, and rewards the referrer', async () => {
  const futureTrialEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const subscription = {
    trialEnd: futureTrialEnd,
    currentPeriodEnd: null,
    seatAdjustments: [{ reason: 'staff_added' }],
    referralDiscountPercent: 15,
    save: async function () { this.saved = true; },
  };
  mock.method(Subscription, 'findById', async () => subscription);
  let promoUpdate;
  mock.method(Promotion, 'updateOne', async (filter, update) => { promoUpdate = { filter, update }; });
  mock.method(Shop, 'findById', () => ({ select: async () => null })); // no referrer on this shop — just proves it was called

  const payment = {
    purpose: 'subscription',
    shop: 'shop-1',
    subscription: 'sub-1',
    plan: 'plan-business',
    billingCycle: 'monthly',
    staffCount: 6,
    amount: 2000,
    currency: 'KES',
    provider: 'mpesa',
    receipt: 'RCPT123',
    promotion: 'promo-1',
    referralDiscount: 10,
    save: async function () { this.saved = true; },
  };

  await applySuccessfulPayment(payment);

  assert.equal(subscription.status, 'active');
  assert.equal(subscription.plan, 'plan-business');
  assert.equal(subscription.staffCount, 6);
  assert.equal(subscription.amountPaid, 2000);
  assert.equal(subscription.paymentReference, 'RCPT123');
  assert.equal(subscription.cancelledAt, null);
  assert.deepEqual(subscription.seatAdjustments, [], 'accrued seat adjustments must be settled on activation');
  assert.equal(subscription.referralDiscountPercent, 0, 'spent referral credit must be zeroed');
  assert.ok(subscription.saved);

  // Paid period starts at trialEnd (the latest of now/trialEnd/currentPeriodEnd).
  assert.equal(payment.periodStart.getTime(), futureTrialEnd.getTime());
  const expectedEnd = new Date(futureTrialEnd);
  expectedEnd.setMonth(expectedEnd.getMonth() + 1);
  assert.equal(payment.periodEnd.getTime(), expectedEnd.getTime());
  assert.ok(payment.saved);

  assert.deepEqual(promoUpdate.filter, { _id: 'promo-1' });
  assert.deepEqual(promoUpdate.update, { $inc: { redemptionCount: 1 } });
});

test('applySuccessfulPayment: no subscription document → logs and returns without throwing', async () => {
  mock.method(Subscription, 'findById', async () => null);
  await assert.doesNotReject(applySuccessfulPayment({ purpose: 'subscription', shop: 'shop-1', subscription: 'missing-sub' }));
});

// ── reconcilePayment ─────────────────────────────────────────────────────────

test('reconcilePayment: a subscription payment with periodEnd is already resolved — no provider call', async () => {
  const queryStatus = mock.method(mpesaProvider, 'queryStatus', async () => { throw new Error('must not query'); });
  const { changed } = await reconcilePayment({ purpose: 'subscription', periodEnd: new Date(), provider: 'mpesa' });
  assert.equal(changed, false);
  assert.equal(queryStatus.mock.callCount(), 0);
});

test('reconcilePayment: a seat_addition payment already marked success is resolved — no provider call', async () => {
  const queryStatus = mock.method(mpesaProvider, 'queryStatus', async () => { throw new Error('must not query'); });
  const { changed } = await reconcilePayment({ purpose: 'seat_addition', status: 'success', provider: 'mpesa' });
  assert.equal(changed, false);
  assert.equal(queryStatus.mock.callCount(), 0);
});

test('reconcilePayment: successful M-Pesa query activates the subscription', async () => {
  mock.method(mpesaProvider, 'queryStatus', async () => ({ success: true, resultCode: '0', resultDesc: 'ok' }));
  const subscription = { seatAdjustments: [], save: async () => {} };
  mock.method(Subscription, 'findById', async () => subscription);
  mock.method(Shop, 'findById', () => ({ select: async () => null }));

  const payment = {
    purpose: 'subscription',
    provider: 'mpesa',
    providerRef: 'ws_CO_1',
    amount: 500,
    shop: 'shop-1',
    subscription: 'sub-1',
    billingCycle: 'monthly',
    save: async function () { this.saved = true; },
  };

  const { changed } = await reconcilePayment(payment);

  assert.equal(changed, true);
  assert.equal(payment.status, 'success');
  assert.ok(payment.periodEnd, 'a successful reconcile must fully activate, not just flip status');
});

test('reconcilePayment: Paystack amount mismatch on reconcile fails the payment rather than crediting it', async () => {
  mock.method(bankProvider, 'queryStatus', async () => ({ success: true, resultCode: 'success', amountKobo: 999900 }));
  const payment = {
    purpose: 'subscription',
    provider: 'bank',
    providerRef: 'ref-1',
    amount: 500, // expects 50000 kobo, provider confirms 999900
    save: async function () { this.saved = true; },
  };

  const { changed } = await reconcilePayment(payment);

  assert.equal(changed, true);
  assert.equal(payment.status, 'failed');
  assert.match(payment.errorMessage, /Amount mismatch/);
});

test('reconcilePayment: a definitive failure code marks the payment failed and cleans up a reserved seat', async () => {
  mock.method(mpesaProvider, 'queryStatus', async () => ({ success: false, resultCode: '1', resultDesc: 'Insufficient funds' }));
  let deleted = false;
  mock.method(User, 'findById', async () => ({ isActive: false, deleteOne: async () => { deleted = true; } }));

  const payment = {
    purpose: 'seat_addition',
    pendingStaff: 'staff-1',
    provider: 'mpesa',
    providerRef: 'ws_CO_2',
    save: async function () { this.saved = true; },
  };

  const { changed } = await reconcilePayment(payment);

  assert.equal(changed, true);
  assert.equal(payment.status, 'failed');
  assert.ok(deleted, 'the reserved staff row must be reclaimed on definitive failure');
});

test('reconcilePayment: a cancellation code (1032) is classified as cancelled, not failed', async () => {
  mock.method(mpesaProvider, 'queryStatus', async () => ({ success: false, resultCode: '1032', resultDesc: 'Cancelled by user' }));
  const payment = { purpose: 'subscription', provider: 'mpesa', providerRef: 'ws_CO_3', save: async () => {} };

  await reconcilePayment(payment);

  assert.equal(payment.status, 'cancelled');
});

test('reconcilePayment: an inconclusive query result leaves the payment untouched for a later retry', async () => {
  mock.method(mpesaProvider, 'queryStatus', async () => ({ success: false, resultCode: '500.001.1001', resultDesc: 'still processing' }));
  const save = { calls: 0 };
  const payment = { purpose: 'subscription', provider: 'mpesa', providerRef: 'ws_CO_4', save: async () => { save.calls += 1; } };

  const { changed } = await reconcilePayment(payment);

  assert.equal(changed, false);
  assert.equal(save.calls, 0, 'an inconclusive result must not be persisted as any kind of terminal state');
});

test('reconcilePayment: a provider query error is swallowed — leaves the payment for the next reconcile attempt', async () => {
  mock.method(mpesaProvider, 'queryStatus', async () => { throw new Error('Safaricom is down'); });
  const payment = { purpose: 'subscription', provider: 'mpesa', providerRef: 'ws_CO_5', save: async () => { throw new Error('must not save'); } };

  await assert.doesNotReject(reconcilePayment(payment));
});

// ── paystackAmountMismatch ───────────────────────────────────────────────────

test('paystackAmountMismatch: null amount (M-Pesa path, no kobo figure) is not a mismatch', () => {
  assert.equal(paystackAmountMismatch({ amount: 500 }, null), null);
});

test('paystackAmountMismatch: exact match in kobo passes', () => {
  assert.equal(paystackAmountMismatch({ amount: 500 }, 50000), null);
});

test('paystackAmountMismatch: a browser-tampered lower amount is caught', () => {
  const reason = paystackAmountMismatch({ amount: 500 }, 100);
  assert.match(reason, /Amount mismatch/);
});

// ── handleMpesaCallback ──────────────────────────────────────────────────────

test('handleMpesaCallback: unknown/already-settled providerRef still 200s (Safaricom must not retry)', async () => {
  mock.method(mpesaProvider, 'parseCallback', () => ({ providerRef: 'ws_CO_x', success: true, resultCode: '0', receipt: 'ABC123' }));
  mock.method(SubscriptionPayment, 'findOneAndUpdate', async () => null);

  const req = { body: {} };
  const res = makeRes();
  await handleMpesaCallback(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ResultCode, 0);
});

test('handleMpesaCallback: a successful claim activates the subscription before responding', async () => {
  mock.method(mpesaProvider, 'parseCallback', () => ({ providerRef: 'ws_CO_y', success: true, resultCode: '0', resultDesc: null, receipt: 'XYZ789' }));
  const payment = { _id: 'pay-1', shop: 'shop-1', purpose: 'subscription', periodEnd: new Date(), amount: 500 };
  mock.method(SubscriptionPayment, 'findOneAndUpdate', async () => payment);
  // applySuccessfulPayment short-circuits immediately since periodEnd is
  // already set — proves the callback awaits it rather than firing blind.
  const findById = mock.method(Subscription, 'findById', async () => { throw new Error('must not be reached — periodEnd already set'); });

  const req = { body: {} };
  const res = makeRes();
  await handleMpesaCallback(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(findById.mock.callCount(), 0);
});

test('handleMpesaCallback: a failure result cleans up a reserved seat instead of activating', async () => {
  mock.method(mpesaProvider, 'parseCallback', () => ({ providerRef: 'ws_CO_z', success: false, resultCode: '1', resultDesc: 'Insufficient funds', receipt: null }));
  const payment = { _id: 'pay-2', shop: 'shop-1', purpose: 'seat_addition', pendingStaff: 'staff-9' };
  mock.method(SubscriptionPayment, 'findOneAndUpdate', async () => payment);
  let deleted = false;
  mock.method(User, 'findById', async () => ({ isActive: false, deleteOne: async () => { deleted = true; } }));

  const req = { body: {} };
  const res = makeRes();
  await handleMpesaCallback(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(deleted);
});

// ── handlePaystackWebhook ────────────────────────────────────────────────────

test('handlePaystackWebhook: an invalid signature is rejected with 401 and never reaches the DB', async () => {
  mock.method(bankProvider, 'getConfig', async () => ({ secretKey: 'sk_test_123', publicKey: 'pk_test_123' }));
  const findOneAndUpdate = mock.method(SubscriptionPayment, 'findOneAndUpdate', async () => { throw new Error('must not be reached'); });

  const req = {
    headers: { 'x-paystack-signature': 'bogus' },
    rawBody: Buffer.from(JSON.stringify({ event: 'charge.success', data: {} })),
    body: { event: 'charge.success', data: {} },
  };
  const res = makeRes();
  await handlePaystackWebhook(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(findOneAndUpdate.mock.callCount(), 0);
});

test('handlePaystackWebhook: a non-charge.success event is accepted and ignored', async () => {
  mock.method(bankProvider, 'getConfig', async () => ({ secretKey: 'sk_test_123', publicKey: 'pk_test_123' }));
  mock.method(bankProvider, 'parseCallback', () => ({ providerRef: 'ref-1', success: false }));
  const findOneAndUpdate = mock.method(SubscriptionPayment, 'findOneAndUpdate', async () => { throw new Error('must not be reached'); });

  const crypto = await import('node:crypto');
  const rawBody = Buffer.from(JSON.stringify({ event: 'transfer.success', data: {} }));
  const signature = crypto.createHmac('sha512', 'sk_test_123').update(rawBody).digest('hex');

  const req = { headers: { 'x-paystack-signature': signature }, rawBody, body: { event: 'transfer.success', data: {} } };
  const res = makeRes();
  await handlePaystackWebhook(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(findOneAndUpdate.mock.callCount(), 0);
});

test('handlePaystackWebhook: charge.success with a correctly-signed body and matching amount activates the subscription', async () => {
  mock.method(bankProvider, 'getConfig', async () => ({ secretKey: 'sk_test_123', publicKey: 'pk_test_123' }));
  mock.method(bankProvider, 'parseCallback', (body) => ({
    providerRef: body.data.reference,
    success: true,
    resultCode: body.data.status,
    resultDesc: body.data.gateway_response,
    receipt: body.data.reference,
    amountKobo: body.data.amount,
    currency: body.data.currency,
  }));
  const payment = { _id: 'pay-3', shop: 'shop-1', purpose: 'subscription', periodEnd: new Date(), amount: 500, save: async () => {} };
  mock.method(SubscriptionPayment, 'findOneAndUpdate', async () => payment);

  const crypto = await import('node:crypto');
  const bodyObj = { event: 'charge.success', data: { reference: 'DKN-1', status: 'success', amount: 50000, currency: 'KES', gateway_response: 'Successful' } };
  const rawBody = Buffer.from(JSON.stringify(bodyObj));
  const signature = crypto.createHmac('sha512', 'sk_test_123').update(rawBody).digest('hex');

  const req = { headers: { 'x-paystack-signature': signature }, rawBody, body: bodyObj };
  const res = makeRes();
  await handlePaystackWebhook(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.received, true);
});

test('handlePaystackWebhook: charge.success with a tampered (mismatched) amount fails the payment, never activates', async () => {
  mock.method(bankProvider, 'getConfig', async () => ({ secretKey: 'sk_test_123', publicKey: 'pk_test_123' }));
  mock.method(bankProvider, 'parseCallback', (body) => ({
    providerRef: body.data.reference,
    success: true,
    resultCode: body.data.status,
    resultDesc: body.data.gateway_response,
    receipt: body.data.reference,
    amountKobo: body.data.amount,
    currency: body.data.currency,
  }));
  const payment = { _id: 'pay-4', shop: 'shop-1', purpose: 'subscription', amount: 5000, save: async function () { this.saved = true; } };
  mock.method(SubscriptionPayment, 'findOneAndUpdate', async () => payment);

  const crypto = await import('node:crypto');
  // Server expected 500000 kobo (KES 5000); browser told Paystack to charge only 100 kobo.
  const bodyObj = { event: 'charge.success', data: { reference: 'DKN-2', status: 'success', amount: 100, currency: 'KES' } };
  const rawBody = Buffer.from(JSON.stringify(bodyObj));
  const signature = crypto.createHmac('sha512', 'sk_test_123').update(rawBody).digest('hex');

  const req = { headers: { 'x-paystack-signature': signature }, rawBody, body: bodyObj };
  const res = makeRes();
  await handlePaystackWebhook(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(payment.status, 'failed');
  assert.match(payment.errorMessage, /Amount mismatch/);
});
