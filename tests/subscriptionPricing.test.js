import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickPlanForStaffCount,
  monthlyTotalForPlan,
  yearlyTotalForPlan,
  applyPromotion,
  applyReferralCredit,
  computePrice,
  computeSeatAdditionImpact,
} from '../src/services/subscriptionPricingService.js';
import Promotion from '../src/models/Promotion.js';

// Pure pricing math — no DB. Fixtures mirror the seeded defaults.

const starter = {
  _id: 'plan-starter',
  slug: 'starter',
  billingType: 'per_staff',
  monthlyPrice: 210,
  yearlyDiscountPercent: 20,
  yearlyPrice: null,
  maxStaff: 9,
  extraStaffPrice: 0,
  currency: 'KES',
  active: true,
};

const business = {
  _id: 'plan-business',
  slug: 'business',
  billingType: 'flat',
  monthlyPrice: 2000,
  yearlyDiscountPercent: 20,
  yearlyPrice: null,
  maxStaff: 20,
  extraStaffPrice: 100,
  currency: 'KES',
  active: true,
};

const plans = [business, starter]; // deliberately unsorted

test('tier selection: 1–9 staff → starter, 10–20 → business, 21+ → business', () => {
  assert.equal(pickPlanForStaffCount(plans, 1).slug, 'starter');
  assert.equal(pickPlanForStaffCount(plans, 9).slug, 'starter');
  assert.equal(pickPlanForStaffCount(plans, 10).slug, 'business');
  assert.equal(pickPlanForStaffCount(plans, 20).slug, 'business');
  assert.equal(pickPlanForStaffCount(plans, 21).slug, 'business');
});

test('tier selection ignores inactive plans', () => {
  const picked = pickPlanForStaffCount([{ ...starter, active: false }, business], 2);
  assert.equal(picked.slug, 'business');
});

test('monthly totals across the CEO tier boundaries', () => {
  assert.equal(monthlyTotalForPlan(starter, 1), 210);
  assert.equal(monthlyTotalForPlan(starter, 9), 1890);
  assert.equal(monthlyTotalForPlan(business, 10), 2000);
  assert.equal(monthlyTotalForPlan(business, 20), 2000);
  // Beyond the top tier: 2000 + (n − 20) × extraStaffPrice
  assert.equal(monthlyTotalForPlan(business, 21), 2100);
  assert.equal(monthlyTotalForPlan(business, 25), 2500);
});

test('yearly price applies the discount and reports savings', () => {
  // 210 × 12 × 0.8
  assert.equal(yearlyTotalForPlan(starter, 1), 2016);
  // 2000 × 12 × 0.8
  assert.equal(yearlyTotalForPlan(business, 10), 19200);

  const price = computePrice({ plans, staffCount: 10, billingCycle: 'yearly' });
  assert.equal(price.amountDue, 19200);
  assert.equal(price.yearlySavings, 4800);
});

test('explicit yearlyPrice overrides the computed discount for flat plans', () => {
  const plan = { ...business, yearlyPrice: 18000 };
  assert.equal(yearlyTotalForPlan(plan, 15), 18000);
  // ...but not when the head-count overflows the tier (extra staff must be charged)
  assert.equal(yearlyTotalForPlan(plan, 21), Math.round(2100 * 12 * 0.8));
});

test('percentage and fixed promotions', () => {
  assert.deepEqual(applyPromotion(2000, { discountType: 'percentage', discountValue: 50 }), { amount: 1000, discount: 1000 });
  assert.deepEqual(applyPromotion(2016, { discountType: 'fixed', discountValue: 500 }), { amount: 1516, discount: 500 });
  // A fixed discount can never push the price below zero
  assert.deepEqual(applyPromotion(210, { discountType: 'fixed', discountValue: 999 }), { amount: 0, discount: 210 });
});

test('applyReferralCredit stacks a percentage discount, clamped to the amount and to 0-100', () => {
  assert.deepEqual(applyReferralCredit(1000, 20), { amount: 800, discount: 200 });
  assert.deepEqual(applyReferralCredit(1000, 0), { amount: 1000, discount: 0 });
  // Clamped even if a caller somehow passes an out-of-range value — the
  // function doesn't trust the schema's own 0-100 cap to have held.
  assert.deepEqual(applyReferralCredit(1000, 150), { amount: 0, discount: 1000 });
  assert.deepEqual(applyReferralCredit(1000, -20), { amount: 1000, discount: 0 });
});

test('computePrice stacks a referral credit on top of an already-applied promotion, not the raw base price', () => {
  const promotion = { discountType: 'percentage', discountValue: 50 };
  const price = computePrice({ plans, plan: starter, staffCount: 3, billingCycle: 'monthly', promotion, referralCreditPercent: 20 });
  // base 630 -> promo 50% off -> 315 (promoDiscount 315) -> referral 20% of 315 -> 252 (referralDiscount 63)
  assert.equal(price.promoDiscount, 315);
  assert.equal(price.referralDiscount, 63);
  assert.equal(price.amountDue, 252);
});

test('computePrice with no referral credit behaves exactly as before (referralDiscount 0)', () => {
  const price = computePrice({ plans, plan: starter, staffCount: 3, billingCycle: 'monthly' });
  assert.equal(price.referralDiscount, 0);
  assert.equal(price.amountDue, 630);
});

test('computePrice honours a forced plan choice over the recommended tier', () => {
  const price = computePrice({ plans, plan: business, staffCount: 3, billingCycle: 'monthly' });
  assert.equal(price.plan.slug, 'business');
  assert.equal(price.amountDue, 2000);
});

test('computePrice picks the tier when no plan is forced', () => {
  const price = computePrice({ plans, staffCount: 3, billingCycle: 'monthly' });
  assert.equal(price.plan.slug, 'starter');
  assert.equal(price.amountDue, 630);
});

test('computeSeatAdditionImpact flags a bill increase on a per-staff plan', () => {
  const impact = computeSeatAdditionImpact(starter, 2, 'monthly');
  assert.equal(impact.currentAmount, 420);
  assert.equal(impact.projectedAmount, 630);
  assert.equal(impact.increased, true);
});

test('computeSeatAdditionImpact is a no-op inside a flat plan\'s included seats', () => {
  const impact = computeSeatAdditionImpact(business, 5, 'monthly');
  assert.equal(impact.currentAmount, 2000);
  assert.equal(impact.projectedAmount, 2000);
  assert.equal(impact.increased, false);
});

test('computeSeatAdditionImpact flags overflow past a flat plan\'s max staff', () => {
  const impact = computeSeatAdditionImpact(business, 20, 'monthly');
  assert.equal(impact.currentAmount, 2000);
  assert.equal(impact.projectedAmount, 2100);
  assert.equal(impact.increased, true);
});

test('promotion redeemability windows and caps', () => {
  const now = new Date('2026-07-10T12:00:00Z');
  const base = { code: 'X', title: 'x', discountType: 'fixed', discountValue: 100 };

  assert.equal(new Promotion({ ...base, active: true }).isRedeemable(now), true);
  assert.equal(new Promotion({ ...base, active: false }).isRedeemable(now), false);
  assert.equal(new Promotion({ ...base, startsAt: new Date('2026-08-01') }).isRedeemable(now), false);
  assert.equal(new Promotion({ ...base, endsAt: new Date('2026-07-01') }).isRedeemable(now), false);
  assert.equal(new Promotion({ ...base, maxRedemptions: 5, redemptionCount: 5 }).isRedeemable(now), false);
  assert.equal(new Promotion({ ...base, maxRedemptions: 5, redemptionCount: 4 }).isRedeemable(now), true);
});
