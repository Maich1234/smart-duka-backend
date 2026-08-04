import { monthlyTotalForPlan, yearlyTotalForPlan } from './subscriptionPricingService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Nominal period lengths used for proration. The exact calendar length of the
// period isn't stored (only currentPeriodEnd is), and a nominal divisor is
// both close enough for a sub-KES-1 rounding and stable across month lengths.
const PERIOD_DAYS = { monthly: 30, yearly: 365 };

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * How much of the current billing period is still unused, as 0–1.
 *
 * A shop that hasn't paid yet (trialing, or expired into grace) has no period
 * to prorate against, so head-count changes are free until the next invoice
 * prices the whole team from scratch — which is the correct outcome, not a
 * loophole: the renewal quote always recounts live head-count.
 */
export function periodFractionRemaining(subscription, now = new Date()) {
  const end = subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  if (!end || end <= now) return 0;

  const periodMs = (PERIOD_DAYS[subscription.billingCycle] ?? PERIOD_DAYS.monthly) * DAY_MS;
  return clamp01((end - now) / periodMs);
}

/** Full-period price for a head-count on a plan, respecting the billing cycle. */
function totalFor(plan, count, billingCycle) {
  return billingCycle === 'yearly'
    ? yearlyTotalForPlan(plan, count)
    : monthlyTotalForPlan(plan, count);
}

/**
 * Prices a head-count change without taking any money.
 *
 * Replaces the old charge-a-full-period-up-front behaviour: adding a cashier
 * on day 28 of a monthly cycle used to cost a full KES 210 (and a full
 * discounted *year* on annual billing) with no credit at renewal 48 hours
 * later. Now it costs 2/30ths of the delta, billed on the next invoice.
 *
 * Returns a plain object; nothing is persisted here.
 */
export function computeSeatChange({ plan, subscription, fromCount, toCount, now = new Date() }) {
  const billingCycle = subscription?.billingCycle ?? 'monthly';
  const fullAmount = totalFor(plan, toCount, billingCycle) - totalFor(plan, fromCount, billingCycle);
  const fractionRemaining = periodFractionRemaining(subscription, now);

  return {
    fromCount,
    toCount,
    fullAmount,
    proratedAmount: Math.round(fullAmount * fractionRemaining),
    fractionRemaining,
  };
}

/**
 * Records a head-count change against the subscription for the next invoice.
 * Saves the subscription. No-ops (without saving) when the change is worth
 * nothing — a flat plan with room left in the tier, or a shop with no paid
 * period to prorate against.
 *
 * Returns the adjustment that was stored, or null.
 */
export async function accrueSeatChange({ subscription, plan, fromCount, toCount, reason, staff = null, now = new Date() }) {
  if (!subscription || !plan || fromCount === toCount) return null;

  const change = computeSeatChange({ plan, subscription, fromCount, toCount, now });
  if (change.proratedAmount === 0) return null;

  const adjustment = {
    ...change,
    reason,
    staff: staff?._id ?? null,
    staffName: staff?.name ?? '',
    createdAt: now,
  };

  subscription.seatAdjustments.push(adjustment);
  await subscription.save();
  return adjustment;
}

/**
 * Net accrued seat charges awaiting the next invoice. Floored at zero — net
 * credits reduce the current invoice to at most its base price, they never
 * produce a negative amount due or a refund.
 */
export function getAccruedSeatTotal(subscription) {
  const net = (subscription?.seatAdjustments ?? [])
    .reduce((sum, a) => sum + (a.proratedAmount ?? 0), 0);
  return Math.max(0, Math.round(net));
}

/**
 * Human-readable lines for the "why is my bill this amount" breakdown on the
 * renewal screen. Credits keep their sign so the list reads honestly.
 */
export function describeSeatAdjustments(subscription) {
  const LABELS = {
    staff_added: 'Added',
    staff_reactivated: 'Reactivated',
    staff_deactivated: 'Deactivated',
    staff_removed: 'Removed',
    staff_account_closed: 'Account closed by',
  };
  return (subscription?.seatAdjustments ?? []).map((a) => ({
    label: `${LABELS[a.reason] ?? 'Changed'} ${a.staffName || 'team member'}`,
    amount: a.proratedAmount,
    daysBilled: Math.round(a.fractionRemaining * (PERIOD_DAYS[subscription.billingCycle] ?? 30)),
    at: a.createdAt,
  }));
}

/** Wipes accrued adjustments once they've been folded into a paid invoice. */
export function clearSeatAdjustments(subscription) {
  subscription.seatAdjustments = [];
}

/**
 * Books the seat credit for a staff account that has just been deleted, and
 * re-snapshots the subscription's head-count.
 *
 * Call AFTER the user document is actually gone (and outside any transaction
 * that removed it) — the credit is derived from a live re-count, so a delete
 * that hasn't committed yet would produce the wrong number.
 *
 * Shared by both removal paths on purpose. The owner-initiated one
 * (staffController.deleteStaff) did this inline, while accounts destroyed by
 * purgeScheduledDeletions — a staff member closing their own account — skipped
 * it entirely, so the shop kept paying for a seat nobody occupied and
 * `staffCount` drifted permanently out of sync. That drift is exactly the bug
 * the head-count write-back below was added to fix once already.
 *
 * Inactive accounts were never billable, so they release nothing.
 */
export async function releaseStaffSeat({ shopId, staff, wasActive, reason = 'staff_removed' }) {
  if (!wasActive || !shopId) return null;

  // Imported lazily: subscriptionPricingService pulls in the User model, and a
  // top-level cycle here would leave one of the two half-initialised.
  const [{ getBillableUserCount }, { default: Subscription }] = await Promise.all([
    import('./subscriptionPricingService.js'),
    import('../models/Subscription.js'),
  ]);

  const subscription = await Subscription.findOne({ shop: shopId }).populate('plan');
  if (!subscription) return null;

  const afterCount = await getBillableUserCount(shopId);

  const adjustment = subscription.plan
    ? await accrueSeatChange({
        subscription,
        plan: subscription.plan,
        fromCount: afterCount + 1,
        toCount: afterCount,
        reason,
        staff,
      })
    : null;

  // Written back even when the credit is worth nothing (flat plan, unpaid
  // period) — the snapshot has to match reality either way.
  subscription.staffCount = afterCount;
  await subscription.save();

  return adjustment;
}
