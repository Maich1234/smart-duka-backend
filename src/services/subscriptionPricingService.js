import User from '../models/User.js';
import Subscription from '../models/Subscription.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Billable head-count for a shop: the owner plus every active staff account.
 * Never below 1 — a solo owner is one billable user.
 */
export async function getBillableUserCount(shopId) {
  const count = await User.countDocuments({ shop: shopId, isActive: true });
  return Math.max(count, 1);
}

/**
 * Picks the tier that covers a given head-count: the cheapest active plan
 * whose maxStaff fits, or the largest tier (extra users are charged at its
 * extraStaffPrice) when the team outgrows every plan.
 */
export function pickPlanForStaffCount(plans, staffCount) {
  const active = plans
    .filter((p) => p.active !== false)
    .sort((a, b) => a.maxStaff - b.maxStaff);
  if (active.length === 0) return null;
  return active.find((p) => staffCount <= p.maxStaff) ?? active[active.length - 1];
}

/** Monthly total for one plan at a given head-count (tier overflow included). */
export function monthlyTotalForPlan(plan, staffCount) {
  let total = plan.billingType === 'per_staff'
    ? staffCount * plan.monthlyPrice
    : plan.monthlyPrice;
  if (staffCount > plan.maxStaff && plan.extraStaffPrice > 0) {
    total += (staffCount - plan.maxStaff) * plan.extraStaffPrice;
  }
  return Math.round(total);
}

/**
 * What adding one more billable seat does to the shop's bill on its current
 * plan — the check behind the "this will increase your bill" confirmation
 * shown before a new staff account is created.
 */
export function computeSeatAdditionImpact(plan, currentStaffCount, billingCycle = 'monthly') {
  const totalFor = (count) => totalForCycle(plan, count, billingCycle);
  const currentAmount = totalFor(currentStaffCount);
  const projectedAmount = totalFor(currentStaffCount + 1);
  return { currentAmount, projectedAmount, increased: projectedAmount > currentAmount };
}

/** Quarterly total: monthly × 3 less the quarterly discount. */
export function quarterlyTotalForPlan(plan, staffCount) {
  const monthly = monthlyTotalForPlan(plan, staffCount);
  const discount = (plan.quarterlyDiscountPercent ?? 0) / 100;
  return Math.round(monthly * 3 * (1 - discount));
}

/** Yearly total: explicit override, else monthly × 12 less the yearly discount. */
export function yearlyTotalForPlan(plan, staffCount) {
  if (plan.yearlyPrice != null && plan.billingType === 'flat' && staffCount <= plan.maxStaff) {
    return Math.round(plan.yearlyPrice);
  }
  const monthly = monthlyTotalForPlan(plan, staffCount);
  const discount = (plan.yearlyDiscountPercent ?? 0) / 100;
  return Math.round(monthly * 12 * (1 - discount));
}

/** Full-period total for a head-count on a plan, for any billing cycle. */
export function totalForCycle(plan, staffCount, billingCycle = 'monthly') {
  if (billingCycle === 'yearly') return yearlyTotalForPlan(plan, staffCount);
  if (billingCycle === 'quarterly') return quarterlyTotalForPlan(plan, staffCount);
  return monthlyTotalForPlan(plan, staffCount);
}

/**
 * Applies a promotion to an amount. Returns { amount, discount }.
 * The promotion must already have been checked with isRedeemable().
 */
export function applyPromotion(amount, promotion) {
  if (!promotion) return { amount, discount: 0 };
  let discount = promotion.discountType === 'percentage'
    ? Math.round(amount * (promotion.discountValue / 100))
    : Math.round(promotion.discountValue);
  discount = Math.min(discount, amount);
  return { amount: amount - discount, discount };
}

/**
 * A second, independent discount stacked on top of whatever a promotion
 * already produced — the shop's own banked referral credit (see
 * Subscription.referralDiscountPercent). Applied to the post-promo amount,
 * not the raw base price, so a promo code and a referral credit both apply
 * to the plan price rather than one discounting the other's discount.
 * Clamped defensively even though the schema already caps the stored value
 * at 100 — this function shouldn't trust its caller.
 */
export function applyReferralCredit(amount, referralCreditPercent) {
  const pct = Math.min(Math.max(referralCreditPercent || 0, 0), 100);
  if (pct === 0) return { amount, discount: 0 };
  const discount = Math.min(Math.round(amount * (pct / 100)), amount);
  return { amount: amount - discount, discount };
}

/**
 * Full price computation for a shop. `plan` may be forced (user picked a
 * card); otherwise the tier is chosen from the head-count.
 *
 * Returns everything the pricing screen and the payment initiator need:
 * { plan, staffCount, billingCycle, monthlyTotal, quarterlyTotal, yearlyTotal,
 *   quarterlySavings, yearlySavings, amountDue, promoDiscount,
 *   referralDiscount, currency }
 */
export function computePrice({
  plans, plan = null, staffCount, billingCycle = 'monthly', promotion = null, referralCreditPercent = 0,
}) {
  const chosen = plan ?? pickPlanForStaffCount(plans, staffCount);
  if (!chosen) throw new Error('No active subscription plans are configured');

  const monthlyTotal = monthlyTotalForPlan(chosen, staffCount);
  const quarterlyTotal = quarterlyTotalForPlan(chosen, staffCount);
  const yearlyTotal = yearlyTotalForPlan(chosen, staffCount);
  const quarterlySavings = Math.max(monthlyTotal * 3 - quarterlyTotal, 0);
  const yearlySavings = Math.max(monthlyTotal * 12 - yearlyTotal, 0);

  const base = totalForCycle(chosen, staffCount, billingCycle);
  const { amount: afterPromo, discount: promoDiscount } = applyPromotion(base, promotion);
  const { amount: afterReferral, discount: referralDiscount } = applyReferralCredit(afterPromo, referralCreditPercent);

  return {
    plan: chosen,
    staffCount,
    billingCycle,
    monthlyTotal,
    quarterlyTotal,
    yearlyTotal,
    quarterlySavings,
    yearlySavings,
    amountDue: afterReferral,
    promoDiscount,
    referralDiscount,
    currency: chosen.currency ?? 'KES',
  };
}

/**
 * Derives the shop's real access state from its subscription record and the
 * clock — the single source of truth for banners, reminders, and the lock
 * screen. Stored status never needs a cron to flip it.
 *
 * States:
 *  none      — no subscription yet (offer the trial)
 *  trialing  — inside the free trial          (daysLeft until trialEnd)
 *  active    — inside a paid period           (daysLeft until currentPeriodEnd)
 *  grace     — expired, within gracePeriodDays (graceDaysLeft until lock)
 *  locked    — expired and grace exhausted
 * cancelled subscriptions keep access until whatever period was already
 * paid/granted runs out, then go straight through grace → locked.
 */
export function deriveAccess(subscription, gracePeriodDays = 3, now = new Date()) {
  if (!subscription) {
    return { state: 'none', daysLeft: 0, graceDaysLeft: 0, expiresAt: null, cancelled: false };
  }

  // Support-granted breathing room extends the window for this shop only.
  gracePeriodDays += subscription.graceExtensionDays ?? 0;

  const cancelled = subscription.status === 'cancelled';
  // The latest date access has been granted to.
  const paidEnd = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  const trialEnd = subscription.trialEnd ? new Date(subscription.trialEnd) : null;
  const expiresAt = [paidEnd, trialEnd]
    .filter(Boolean)
    .sort((a, b) => b - a)[0] ?? null;

  if (!expiresAt) {
    return { state: 'none', daysLeft: 0, graceDaysLeft: 0, expiresAt: null, cancelled };
  }

  if (now <= expiresAt) {
    const daysLeft = Math.ceil((expiresAt - now) / DAY_MS);
    const inPaidPeriod = paidEnd && now <= paidEnd;
    return {
      state: inPaidPeriod ? 'active' : 'trialing',
      daysLeft,
      graceDaysLeft: 0,
      expiresAt,
      cancelled,
    };
  }

  const graceEnd = new Date(expiresAt.getTime() + gracePeriodDays * DAY_MS);
  if (now <= graceEnd) {
    return {
      state: 'grace',
      daysLeft: 0,
      graceDaysLeft: Math.ceil((graceEnd - now) / DAY_MS),
      expiresAt,
      cancelled,
    };
  }

  return { state: 'locked', daysLeft: 0, graceDaysLeft: 0, expiresAt, cancelled };
}

/**
 * Whether `role` may still record a transaction for this shop right now, and
 * (for a staff account still inside its extra window) how many days of that
 * runway are left.
 *
 * This is requirePaidShop's own staff-grace math, pulled out here so the live
 * 403 check and the value handed to the client (getMySubscription's
 * `access.canTransact`, read by the till before it completes an offline-first
 * sale) can never drift apart — a client that is offline for the entire owner
 * grace window plus `staffGraceExtraDays` has no other way to learn its true
 * cutoff moved.
 */
export function canTransact(access, { subscription, platform, role }) {
  if (access.state !== 'locked') return { allowed: true, staffGraceDaysLeft: null };
  if (role !== 'staff' || !access.expiresAt) return { allowed: false, staffGraceDaysLeft: null };

  const staffGraceEnd = new Date(
    new Date(access.expiresAt).getTime()
    + (platform.gracePeriodDays + (subscription?.graceExtensionDays ?? 0) + platform.staffGraceExtraDays) * DAY_MS,
  );
  const allowed = new Date() <= staffGraceEnd;
  return { allowed, staffGraceDaysLeft: allowed ? Math.ceil((staffGraceEnd - new Date()) / DAY_MS) : null };
}

const ACCESS_ALLOWED_FOR_INSIGHTS = ['trialing', 'active', 'grace'];

/**
 * Narrows a shop list down to shops with live access (trialing/active/grace)
 * — used by the routine insight crons (daily sales anomaly, depletion,
 * end-of-day summary) so a locked shop doesn't keep getting analytics pushes
 * for a screen its owner can no longer open. Subscription reminders are a
 * separate cron and deliberately keep notifying locked shops too.
 */
export async function filterShopsWithActiveAccess(shops, gracePeriodDays) {
  const subscriptions = await Subscription.find({ shop: { $in: shops.map((s) => s._id) } }).lean();
  const byShop = new Map(subscriptions.map((s) => [String(s.shop), s]));
  return shops.filter((shop) => {
    const access = deriveAccess(byShop.get(String(shop._id)) ?? null, gracePeriodDays);
    return ACCESS_ALLOWED_FOR_INSIGHTS.includes(access.state);
  });
}

/**
 * Which reminder (if any) is due for a subscription right now.
 * Returns { kind, dedupeKey } or null. kind ∈ 'expiry-<n>d' | 'grace' — the
 * dedupe key pins the reminder to the expiry date it was for, so a renewal
 * (which moves expiresAt) naturally re-arms every reminder.
 */
export function dueReminder(subscription, { reminderDaysBefore = [7, 3], gracePeriodDays = 3 } = {}, now = new Date()) {
  const access = deriveAccess(subscription, gracePeriodDays, now);
  if (access.state === 'none' || access.state === 'locked') return null;

  const expiryTag = access.expiresAt.toISOString().slice(0, 10);
  const sent = subscription.remindersSent ?? [];

  if (access.state === 'grace') {
    const key = `grace:${expiryTag}`;
    return sent.includes(key) ? null : { kind: 'grace', dedupeKey: key, access };
  }

  // Inside trial/paid period: fire the tightest window that has been entered.
  const windows = [...reminderDaysBefore].sort((a, b) => a - b);
  for (const days of windows) {
    if (access.daysLeft <= days) {
      const key = `expiry-${days}d:${expiryTag}`;
      return sent.includes(key) ? null : { kind: `expiry-${days}d`, dedupeKey: key, access };
    }
  }
  return null;
}
