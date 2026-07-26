import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Subscription from '../src/models/Subscription.js';
import PlatformConfig from '../src/models/PlatformConfig.js';
import { requirePaidShop } from '../src/middlewares/requirePaidShop.js';
import { deriveAccess } from '../src/services/subscriptionPricingService.js';
import {
  computeSeatChange,
  getAccruedSeatTotal,
  periodFractionRemaining,
} from '../src/services/seatBillingService.js';

const DAY = 24 * 60 * 60 * 1000;

const starterPlan = {
  billingType: 'per_staff',
  monthlyPrice: 210,
  maxStaff: 9,
  extraStaffPrice: 0,
  yearlyDiscountPercent: 20,
  currency: 'KES',
};

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
}

/** Locked: expired well past any grace window. */
const lockedSubscription = { currentPeriodEnd: new Date(Date.now() - 30 * DAY), billingCycle: 'monthly' };

function stubPlatform({ gracePeriodDays = 3, staffGraceExtraDays = 7 } = {}) {
  mock.method(PlatformConfig, 'get', async () => ({ gracePeriodDays, staffGraceExtraDays }));
}

function stubSubscription(sub) {
  mock.method(Subscription, 'findOne', () => ({ populate: () => ({ lean: async () => sub }) }));
}

beforeEach(() => mock.restoreAll());

// ── requirePaidShop ────────────────────────────────────────────────────────

test('requirePaidShop: an active shop passes through', async () => {
  stubPlatform();
  stubSubscription({ currentPeriodEnd: new Date(Date.now() + 10 * DAY), billingCycle: 'monthly' });

  let nexted = false;
  const res = makeRes();
  await requirePaidShop({ user: { role: 'owner', shop: { _id: 'shop-1' } } }, res, () => { nexted = true; });

  assert.ok(nexted);
});

test('requirePaidShop: a locked owner is blocked from recording sales (closes the revenue leak)', async () => {
  stubPlatform();
  stubSubscription(lockedSubscription);

  let nexted = false;
  const res = makeRes();
  await requirePaidShop({ user: { role: 'owner', shop: { _id: 'shop-1' } } }, res, () => { nexted = true; });

  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'SUBSCRIPTION_LOCKED');
});

test('requirePaidShop: staff keep selling through the extra grace window — the till stops last', async () => {
  // Owner grace (3d) exhausted 2 days ago, but staff get 7 more.
  stubPlatform({ gracePeriodDays: 3, staffGraceExtraDays: 7 });
  stubSubscription({ currentPeriodEnd: new Date(Date.now() - 5 * DAY), billingCycle: 'monthly' });

  let nexted = false;
  const req = { user: { role: 'staff', shop: { _id: 'shop-1' } } };
  const res = makeRes();
  await requirePaidShop(req, res, () => { nexted = true; });

  assert.ok(nexted, 'a shop that cannot take money churns');
  assert.equal(req.staffGraceDaysLeft, 5);
  assert.equal(res.headers['X-Subscription-Grace-Days-Left'], '5');
});

test('requirePaidShop: staff are blocked once even the extended window closes', async () => {
  stubPlatform({ gracePeriodDays: 3, staffGraceExtraDays: 7 });
  stubSubscription({ currentPeriodEnd: new Date(Date.now() - 40 * DAY), billingCycle: 'monthly' });

  let nexted = false;
  const res = makeRes();
  await requirePaidShop({ user: { role: 'staff', shop: { _id: 'shop-1' } } }, res, () => { nexted = true; });

  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /shop owner to renew/);
});

test('requirePaidShop: a lookup failure never stops the counter', async () => {
  mock.method(PlatformConfig, 'get', async () => { throw new Error('mongo is down'); });
  mock.method(Subscription, 'findOne', () => ({ populate: () => ({ lean: async () => null }) }));

  let nexted = false;
  const res = makeRes();
  await requirePaidShop({ user: { role: 'staff', shop: { _id: 'shop-1' } } }, res, () => { nexted = true; });

  assert.ok(nexted, 'a false lock at the till is worse than a few unbilled transactions');
});

// ── per-shop grace extension ───────────────────────────────────────────────

test('deriveAccess: a support-granted extension holds off the lock for that shop only', () => {
  const expired = { currentPeriodEnd: new Date(Date.now() - 5 * DAY) };

  assert.equal(deriveAccess(expired, 3).state, 'locked');
  assert.equal(
    deriveAccess({ ...expired, graceExtensionDays: 7 }, 3).state,
    'grace',
    'the KES-200-short-until-Friday lever',
  );
});

test('deriveAccess: a zero extension changes nothing', () => {
  const expired = { currentPeriodEnd: new Date(Date.now() - 5 * DAY), graceExtensionDays: 0 };
  assert.equal(deriveAccess(expired, 3).state, 'locked');
});

// ── postpaid seat proration ────────────────────────────────────────────────

test('periodFractionRemaining: unpaid or expired periods prorate to nothing', () => {
  assert.equal(periodFractionRemaining({ currentPeriodEnd: null }), 0);
  assert.equal(periodFractionRemaining({ currentPeriodEnd: new Date(Date.now() - DAY) }), 0);
});

test('computeSeatChange: a seat added late in the cycle costs a fraction, not a full period', () => {
  // 3 of 30 days left — the old behaviour charged the full 210 here, then
  // charged it again at renewal 3 days later.
  const subscription = { billingCycle: 'monthly', currentPeriodEnd: new Date(Date.now() + 3 * DAY) };
  const change = computeSeatChange({ plan: starterPlan, subscription, fromCount: 4, toCount: 5 });

  assert.equal(change.fullAmount, 210);
  assert.equal(change.proratedAmount, 21, '3/30 of 210');
});

test('computeSeatChange: yearly billing prorates too — this was the 12x overcharge', () => {
  // Month 11 of an annual plan: ~30 of 365 days left.
  const subscription = { billingCycle: 'yearly', currentPeriodEnd: new Date(Date.now() + 30 * DAY) };
  const change = computeSeatChange({ plan: starterPlan, subscription, fromCount: 4, toCount: 5 });

  assert.equal(change.fullAmount, 2016, '210 × 12 less the 20% annual discount');
  assert.ok(
    change.proratedAmount > 0 && change.proratedAmount < 200,
    `a seat added in month 11 must not cost a full year, got ${change.proratedAmount}`,
  );
});

test('computeSeatChange: removing a seat produces a credit', () => {
  const subscription = { billingCycle: 'monthly', currentPeriodEnd: new Date(Date.now() + 15 * DAY) };
  const change = computeSeatChange({ plan: starterPlan, subscription, fromCount: 5, toCount: 4 });

  assert.equal(change.fullAmount, -210);
  assert.equal(change.proratedAmount, -105);
});

test('getAccruedSeatTotal: nets additions against credits and never goes negative', () => {
  assert.equal(getAccruedSeatTotal({ seatAdjustments: [{ proratedAmount: 105 }, { proratedAmount: 40 }] }), 145);
  assert.equal(
    getAccruedSeatTotal({ seatAdjustments: [{ proratedAmount: 50 }, { proratedAmount: -400 }] }),
    0,
    'a net credit reduces the invoice to its base price, it never becomes a refund',
  );
  assert.equal(getAccruedSeatTotal({ seatAdjustments: [] }), 0);
  assert.equal(getAccruedSeatTotal(null), 0);
});
