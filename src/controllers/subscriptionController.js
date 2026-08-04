import SubscriptionPlan from '../models/SubscriptionPlan.js';
import Subscription from '../models/Subscription.js';
import SubscriptionPayment from '../models/SubscriptionPayment.js';
import Promotion from '../models/Promotion.js';
import PlatformConfig from '../models/PlatformConfig.js';
import { DEFAULT_PLANS, YEARLY_OFFER, LAUNCH_OFFER } from '../constants/subscriptionDefaults.js';
import {
  getBillableUserCount,
  pickPlanForStaffCount,
  monthlyTotalForPlan,
  yearlyTotalForPlan,
  computePrice,
  deriveAccess,
} from '../services/subscriptionPricingService.js';
import {
  getAccruedSeatTotal,
  describeSeatAdjustments,
  clearSeatAdjustments,
} from '../services/seatBillingService.js';
import { getPaymentProvider, listPaymentProviders } from '../services/payments/index.js';
import { logAudit } from '../services/auditLogService.js';
import { activateSeatPayment, cleanupFailedSeatPayment } from '../services/seatActivationService.js';
import { MPESA_RECEIPT_PATTERN, MPESA_AMOUNT_PATTERN } from '../utils/mpesaReceipt.js';

const shopIdOf = (req) => req.user.shop._id ?? req.user.shop;

/** Seeds the default Starter/Business plans the first time the API is hit. */
async function ensureDefaultPlans() {
  const count = await SubscriptionPlan.estimatedDocumentCount();
  if (count === 0) await SubscriptionPlan.insertMany(DEFAULT_PLANS);
}

async function getActivePlans() {
  await ensureDefaultPlans();
  return SubscriptionPlan.find({ active: true }).sort({ displayOrder: 1 }).lean();
}

/** Resolves a redeemable promotion by code, or throws a client-friendly error. */
async function resolvePromotion(code) {
  if (!code) return null;
  const promotion = await Promotion.findOne({ code: code.toUpperCase() });
  if (!promotion || !promotion.isRedeemable()) {
    const err = new Error('This promo code is invalid or has expired.');
    err.status = 400;
    throw err;
  }
  return promotion;
}

/**
 * The subscription STK callback needs its own public URL. Prefer the
 * dedicated env var; otherwise derive it from the sale-payment callback URL.
 */
export function getSubscriptionCallbackUrl() {
  if (process.env.SUBSCRIPTION_MPESA_CALLBACK_URL) return process.env.SUBSCRIPTION_MPESA_CALLBACK_URL;
  const saleCallback = process.env.MPESA_CALLBACK_URL;
  if (saleCallback?.includes('/mpesa/callback')) {
    return saleCallback.replace('/mpesa/callback', '/subscriptions/mpesa/callback');
  }
  return null;
}

function addCycle(date, cycle) {
  const d = new Date(date);
  if (cycle === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

/**
 * GET /subscriptions/plans — the entire pricing screen in one payload:
 * plans priced for this shop's head-count, the yearly offer, the earned
 * launch offer, and provider availability. Nothing here is hardcoded in
 * the app.
 */
export const getPlans = async (req, res) => {
  try {
    const shopId = shopIdOf(req);
    const [plans, staffCount, subscription] = await Promise.all([
      getActivePlans(),
      getBillableUserCount(shopId),
      Subscription.findOne({ shop: shopId }).lean(),
    ]);

    const recommended = pickPlanForStaffCount(plans, staffCount);
    const pricedPlans = plans.map((plan) => {
      const monthlyTotal = monthlyTotalForPlan(plan, staffCount);
      const yearlyTotal = yearlyTotalForPlan(plan, staffCount);
      return {
        ...plan,
        pricing: {
          monthlyTotal,
          yearlyTotal,
          yearlySavings: Math.max(monthlyTotal * 12 - yearlyTotal, 0),
        },
        recommended: recommended != null && String(plan._id) === String(recommended._id),
      };
    });

    const trialDays = recommended?.trialDays ?? 30;

    return res.json({
      success: true,
      data: {
        plans: pricedPlans,
        staffCount,
        recommendedPlanSlug: recommended?.slug ?? null,
        currency: recommended?.currency ?? 'KES',
        trialDays,
        yearlyOffer: YEARLY_OFFER,
        launchOffer: {
          title: LAUNCH_OFFER.title,
          headline: LAUNCH_OFFER.headline(trialDays),
          note: LAUNCH_OFFER.note,
        },
        providers: listPaymentProviders(),
        hasSubscription: !!subscription,
      },
    });
  } catch (err) {
    console.error('[Subscriptions] getPlans error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load subscription plans.' });
  }
};

/**
 * GET /subscriptions/preview — recomputes the price for a hypothetical
 * head-count / cycle / promo without touching the subscription.
 */
export const previewPricing = async (req, res) => {
  try {
    const shopId = shopIdOf(req);
    const { billingCycle, planSlug, promoCode } = req.query;
    const staffCount = req.query.staffCount ?? await getBillableUserCount(shopId);

    const plans = await getActivePlans();
    const plan = planSlug ? plans.find((p) => p.slug === planSlug) : null;
    if (planSlug && !plan) {
      return res.status(404).json({ success: false, message: `Unknown plan: ${planSlug}` });
    }
    const promotion = await resolvePromotion(promoCode);

    const price = computePrice({ plans, plan, staffCount: Number(staffCount), billingCycle, promotion });
    return res.json({
      success: true,
      data: {
        planSlug: price.plan.slug,
        planName: price.plan.name,
        staffCount: price.staffCount,
        billingCycle: price.billingCycle,
        monthlyTotal: price.monthlyTotal,
        yearlyTotal: price.yearlyTotal,
        yearlySavings: price.yearlySavings,
        promoDiscount: price.promoDiscount,
        amountDue: price.amountDue,
        currency: price.currency,
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error('[Subscriptions] previewPricing error:', err);
    return res.status(500).json({ success: false, message: 'Failed to compute pricing.' });
  }
};

/** POST /subscriptions/promo/validate — checks a promo code for the UI. */
export const validatePromo = async (req, res) => {
  try {
    const promotion = await resolvePromotion(req.body.code);
    return res.json({
      success: true,
      data: {
        code: promotion.code,
        title: promotion.title,
        description: promotion.description,
        discountType: promotion.discountType,
        discountValue: promotion.discountValue,
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error('[Subscriptions] validatePromo error:', err);
    return res.status(500).json({ success: false, message: 'Failed to validate promo code.' });
  }
};

/**
 * GET /subscriptions/me — the shop's subscription plus its derived access
 * state (trialing/active/grace/locked) and what a renewal would cost now.
 */
export const getMySubscription = async (req, res) => {
  try {
    const shopId = shopIdOf(req);
    const [subscription, platform] = await Promise.all([
      Subscription.findOne({ shop: shopId }).populate('plan').lean(),
      PlatformConfig.get(),
    ]);

    const access = deriveAccess(subscription, platform.gracePeriodDays);

    let renewal = null;
    if (subscription) {
      const plans = await getActivePlans();
      const staffCount = await getBillableUserCount(shopId);
      const livePlan = plans.find((p) => String(p._id) === String(subscription.plan?._id));
      const price = computePrice({
        plans,
        plan: livePlan ?? null,
        staffCount,
        billingCycle: subscription.billingCycle,
      });
      // Mid-period head-count changes are postpaid — their prorated cost
      // rides on this invoice instead of having been charged on the spot.
      const seatCharges = getAccruedSeatTotal(subscription);
      renewal = {
        planSlug: price.plan.slug,
        billingCycle: price.billingCycle,
        basePrice: price.amountDue,
        seatCharges,
        seatAdjustments: describeSeatAdjustments(subscription),
        amountDue: price.amountDue + seatCharges,
        staffCount: price.staffCount,
        currency: price.currency,
      };
    }

    return res.json({
      success: true,
      data: {
        subscription,
        access,
        gracePeriodDays: platform.gracePeriodDays,
        renewal,
      },
    });
  } catch (err) {
    console.error('[Subscriptions] getMySubscription error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load subscription.' });
  }
};

/**
 * POST /subscriptions/trial — activates the free trial once per shop.
 * Idempotent: repeat calls return the existing subscription untouched.
 */
export const activateTrial = async (req, res) => {
  try {
    const shopId = shopIdOf(req);
    const { planSlug, billingCycle } = req.body;

    const existing = await Subscription.findOne({ shop: shopId }).populate('plan');
    if (existing) {
      return res.json({
        success: true,
        data: { subscription: existing, alreadyActivated: true },
        message: 'This shop already has a subscription.',
      });
    }

    const plans = await getActivePlans();
    const staffCount = await getBillableUserCount(shopId);
    const plan = planSlug
      ? plans.find((p) => p.slug === planSlug)
      : pickPlanForStaffCount(plans, staffCount);
    if (!plan) {
      return res.status(404).json({ success: false, message: planSlug ? `Unknown plan: ${planSlug}` : 'No subscription plans are configured.' });
    }

    const now = new Date();
    const trialEnd = new Date(now.getTime() + plan.trialDays * 24 * 60 * 60 * 1000);

    let subscription;
    try {
      subscription = await Subscription.create({
        shop: shopId,
        plan: plan._id,
        status: 'trialing',
        trialStart: now,
        trialEnd,
        billingCycle,
        staffCount,
        currency: plan.currency,
        activatedBy: req.user._id,
      });
    } catch (err) {
      // Unique-index race: a concurrent activation won — return theirs.
      if (err.code === 11000) {
        subscription = await Subscription.findOne({ shop: shopId }).populate('plan');
        return res.json({
          success: true,
          data: { subscription, alreadyActivated: true },
          message: 'This shop already has a subscription.',
        });
      }
      throw err;
    }

    logAudit({
      shopId,
      userId: req.user._id,
      action: 'subscription.trial.activated',
      entityType: 'Subscription',
      entityId: subscription._id,
      details: { planSlug: plan.slug, trialDays: plan.trialDays, staffCount },
      req,
    }).catch(() => {});

    subscription = await subscription.populate('plan');
    return res.status(201).json({
      success: true,
      data: { subscription, alreadyActivated: false, trialEnd },
      message: `Your free ${plan.trialDays}-day trial is active.`,
    });
  } catch (err) {
    console.error('[Subscriptions] activateTrial error:', err);
    return res.status(500).json({ success: false, message: 'Failed to activate the trial.' });
  }
};

/**
 * POST /subscriptions/cancel — marks the subscription cancelled. Access
 * continues until whatever was already granted (trial or paid period) ends.
 */
export const cancelSubscription = async (req, res) => {
  try {
    const shopId = shopIdOf(req);
    const subscription = await Subscription.findOne({ shop: shopId });
    if (!subscription) {
      return res.status(404).json({ success: false, message: 'No subscription to cancel.' });
    }
    if (subscription.status === 'cancelled') {
      return res.json({ success: true, data: { subscription }, message: 'Subscription is already cancelled.' });
    }

    subscription.status = 'cancelled';
    subscription.cancelledAt = new Date();
    await subscription.save();

    logAudit({
      shopId,
      userId: req.user._id,
      action: 'subscription.cancelled',
      entityType: 'Subscription',
      entityId: subscription._id,
      req,
    }).catch(() => {});

    return res.json({
      success: true,
      data: { subscription },
      message: 'Subscription cancelled. You keep access until the end of your current period.',
    });
  } catch (err) {
    console.error('[Subscriptions] cancelSubscription error:', err);
    return res.status(500).json({ success: false, message: 'Failed to cancel the subscription.' });
  }
};

/**
 * POST /subscriptions/pay — charges the owner via the chosen provider
 * (M-Pesa STK Push today). The amount is always computed server-side.
 */
export const initiatePayment = async (req, res) => {
  try {
    const shopId = shopIdOf(req);
    const { phoneNumber, billingCycle, planSlug, promoCode, provider: providerKey } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'];

    // ── 1. Idempotency: a retry must never fire a second STK push ──────────
    if (idempotencyKey) {
      const existing = await SubscriptionPayment.findOne({ shop: shopId, idempotencyKey });
      if (existing) {
        return res.json({
          success: true,
          idempotent: true,
          data: {
            paymentId: existing._id,
            status: existing.status,
            amount: existing.amount,
            receipt: existing.receipt ?? null,
            errorMessage: existing.errorMessage ?? null,
          },
          message: existing.status === 'pending'
            ? 'Payment request already sent. Keep waiting for the M-PESA PIN prompt.'
            : `Duplicate request — payment already ${existing.status}.`,
        });
      }
    }

    // ── 2. Resolve subscription, plan, and server-side price ───────────────
    let subscription = await Subscription.findOne({ shop: shopId });
    const plans = await getActivePlans();
    const staffCount = await getBillableUserCount(shopId);
    const plan = planSlug
      ? plans.find((p) => p.slug === planSlug)
      : plans.find((p) => subscription && String(p._id) === String(subscription.plan))
        ?? pickPlanForStaffCount(plans, staffCount);
    if (!plan) {
      return res.status(404).json({ success: false, message: planSlug ? `Unknown plan: ${planSlug}` : 'No subscription plans are configured.' });
    }

    let promotion = null;
    try {
      promotion = await resolvePromotion(promoCode);
    } catch (err) {
      return res.status(err.status ?? 400).json({ success: false, message: err.message });
    }

    const price = computePrice({ plans, plan, staffCount, billingCycle, promotion });
    // Accrued mid-period seat changes settle on this invoice. Added after the
    // promotion so a discount code applies to the plan price, not to seats
    // already consumed.
    const seatCharges = getAccruedSeatTotal(subscription);
    const amountDue = price.amountDue + seatCharges;
    if (amountDue <= 0) {
      return res.status(400).json({ success: false, message: 'Nothing to pay — the promo covers the full amount. Contact support to apply it.' });
    }

    // A shop that skipped the trial can still pay: create its subscription
    // shell now; the successful payment flips it to active.
    if (!subscription) {
      try {
        subscription = await Subscription.create({
          shop: shopId,
          plan: plan._id,
          status: 'trialing',
          billingCycle,
          staffCount,
          currency: price.currency,
          activatedBy: req.user._id,
        });
      } catch (err) {
        if (err.code !== 11000) throw err;
        subscription = await Subscription.findOne({ shop: shopId });
      }
    }

    // ── 3. Charge via the provider abstraction ─────────────────────────────
    const callbackUrl = getSubscriptionCallbackUrl();
    if (!callbackUrl) {
      return res.status(503).json({
        success: false,
        message: 'SUBSCRIPTION_MPESA_CALLBACK_URL is not configured on the server. Contact the app administrator.',
      });
    }

    const provider = getPaymentProvider(providerKey);
    let charge;
    try {
      charge = await provider.charge({
        phoneNumber,
        amount: amountDue,
        reference: 'DUKANA',
        description: `Dukana ${plan.name} (${billingCycle})`,
        callbackUrl,
      });
    } catch (err) {
      if (err.code === 'PROVIDER_UNAVAILABLE') {
        return res.status(400).json({ success: false, message: err.message });
      }
      if (err.code === 'PLATFORM_PAYMENTS_UNCONFIGURED') {
        return res.status(503).json({ success: false, message: err.message });
      }
      console.error('[Subscriptions] charge failed:', err.message);
      return res.status(503).json({
        success: false,
        message: 'Could not reach M-PESA to start the payment. Please try again in a moment.',
      });
    }

    // ── 4. Record the pending payment ──────────────────────────────────────
    let payment;
    try {
      payment = await SubscriptionPayment.create({
        shop: shopId,
        subscription: subscription._id,
        plan: plan._id,
        billingCycle,
        staffCount,
        amount: amountDue,
        currency: price.currency,
        provider: provider.key,
        providerRef: charge.providerRef,
        merchantRequestId: charge.merchantRequestId,
        phoneNumber: charge.phoneNumber ?? phoneNumber,
        status: 'pending',
        promotion: promotion?._id ?? null,
        promoCode: promotion?.code ?? null,
        promoDiscount: price.promoDiscount,
        requestedBy: req.user._id,
        ...(idempotencyKey && { idempotencyKey }),
      });
    } catch (err) {
      // Idempotency-race recovery, same pattern as mpesaController.
      if (err.code === 11000 && idempotencyKey) {
        const existing = await SubscriptionPayment.findOne({ shop: shopId, idempotencyKey });
        if (existing) {
          return res.json({
            success: true,
            idempotent: true,
            data: { paymentId: existing._id, status: existing.status, amount: existing.amount },
            message: 'Payment request already sent. Keep waiting for the M-PESA PIN prompt.',
          });
        }
      }
      throw err;
    }

    logAudit({
      shopId,
      userId: req.user._id,
      action: 'subscription.payment.initiated',
      entityType: 'SubscriptionPayment',
      entityId: payment._id,
      details: { amount: amountDue, seatCharges, billingCycle, planSlug: plan.slug, provider: provider.key, promoCode: promotion?.code },
      req,
    }).catch(() => {});

    return res.status(201).json({
      success: true,
      data: {
        paymentId: payment._id,
        status: 'pending',
        amount: amountDue,
        currency: price.currency,
        billingCycle,
        planSlug: plan.slug,
      },
      message: 'Payment request sent. Enter your M-PESA PIN on your phone to finish.',
    });
  } catch (err) {
    console.error('[Subscriptions] initiatePayment error:', err);
    return res.status(500).json({ success: false, message: 'An unexpected error occurred while starting the payment.' });
  }
};

/** GET /subscriptions/pay/:paymentId — polls a pending charge. */
export const getPaymentStatus = async (req, res) => {
  try {
    const shopId = shopIdOf(req);
    const payment = await SubscriptionPayment.findOne({ _id: req.params.paymentId, shop: shopId });
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    if (payment.status === 'pending') {
      const ageMs = Date.now() - new Date(payment.createdAt).getTime();
      if (ageMs > 2 * 60 * 1000) {
        payment.status = 'timeout';
        payment.errorMessage = 'The payment request expired before it was confirmed.';
        await payment.save();
      }
    }

    return res.json({
      success: true,
      data: {
        paymentId: payment._id,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        receipt: payment.receipt ?? null,
        periodEnd: payment.periodEnd ?? null,
        errorMessage: payment.errorMessage ?? null,
      },
    });
  } catch (err) {
    console.error('[Subscriptions] getPaymentStatus error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch payment status.' });
  }
};

/**
 * POST /subscriptions/mpesa/callback — Safaricom webhook, public (no JWT).
 * Atomically claims the pending payment so duplicate callbacks are no-ops,
 * then on success extends the subscription: the paid period starts when the
 * trial ends ("your subscription only starts after your trial ends"), or
 * stacks on the current paid period, or starts now — whichever is latest.
 *
 * The response is sent only once processing is fully complete (not before).
 * A payment's DB status must never say "success" while the subscription
 * itself hasn't actually been activated yet — on serverless hosting,
 * "respond first, keep working after" risks the function being frozen
 * mid-activation, leaving a payment permanently marked successful with the
 * subscription never actually unlocked. Safaricom's callback timeout budget
 * comfortably covers the single DB round trip this now takes before replying.
 */
export const handleMpesaCallback = async (req, res) => {
  try {
    const provider = getPaymentProvider('mpesa');
    const parsed = provider.parseCallback(req.body);

    let status;
    if (parsed.success) {
      status = 'success';
    } else if (parsed.resultCode === '1032') {
      status = 'cancelled';
    } else if (parsed.resultCode === '1037' || parsed.resultCode === '1001') {
      status = 'timeout';
    } else {
      status = 'failed';
    }

    // Atomic claim: only one callback can move the payment out of 'pending'.
    const payment = await SubscriptionPayment.findOneAndUpdate(
      { providerRef: parsed.providerRef, status: 'pending' },
      {
        $set: {
          status,
          resultCode: parsed.resultCode,
          errorMessage: parsed.success ? null : parsed.resultDesc,
          receipt: parsed.receipt,
          transactionDate: parsed.success ? new Date() : undefined,
          callbackPayload: req.body,
          callbackReceivedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!payment) {
      console.error('[Subscriptions Callback] Unknown or already-settled providerRef:', parsed.providerRef);
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    if (status === 'success') {
      await applySuccessfulPayment(payment);
    } else {
      await cleanupFailedSeatPayment(payment);
    }

    logAudit({
      shopId: payment.shop,
      action: `subscription.payment.${status}`,
      entityType: 'SubscriptionPayment',
      entityId: payment._id,
      details: { resultCode: parsed.resultCode, receipt: parsed.receipt, amount: payment.amount },
    }).catch(() => {});

    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('[Subscriptions Callback] Processing error:', err.message);
    // Still 200 — Safaricom retries on non-200, and a retry would just replay
    // the same (already-logged) failure. The reconciliation cron/recheck
    // endpoint is the real recovery path for whatever went wrong here.
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
};

/**
 * Extends the subscription for a payment that just succeeded. Idempotent —
 * safe to call more than once for the same payment (the reconciliation path
 * may re-run this for a payment whose activation is uncertain) — a payment
 * only ever gets `periodEnd` set once real processing has happened, so a
 * second call is a no-op rather than double-crediting a promo redemption.
 */
export async function applySuccessfulPayment(payment) {
  if (payment.purpose === 'seat_addition') return activateSeatPayment(payment);
  if (payment.periodEnd) return;

  const subscription = await Subscription.findById(payment.subscription);
  if (!subscription) {
    console.error('[Subscriptions Callback] Payment has no subscription:', payment._id);
    return;
  }

  const now = new Date();
  const candidates = [now];
  if (subscription.trialEnd && subscription.trialEnd > now) candidates.push(new Date(subscription.trialEnd));
  if (subscription.currentPeriodEnd && subscription.currentPeriodEnd > now) candidates.push(new Date(subscription.currentPeriodEnd));
  const periodStart = new Date(Math.max(...candidates.map((d) => d.getTime())));
  const periodEnd = addCycle(periodStart, payment.billingCycle);

  subscription.status = 'active';
  subscription.plan = payment.plan;
  subscription.billingCycle = payment.billingCycle;
  subscription.currentPeriodEnd = periodEnd;
  subscription.staffCount = payment.staffCount;
  subscription.amountPaid = payment.amount;
  subscription.currency = payment.currency;
  subscription.paymentProvider = payment.provider;
  subscription.paymentReference = payment.receipt ?? payment.providerRef;
  subscription.promotion = payment.promotion ?? subscription.promotion;
  subscription.cancelledAt = null;
  // Accrued mid-period seat changes were folded into this payment's amount —
  // settle them so they can't be billed twice on the following invoice.
  clearSeatAdjustments(subscription);
  await subscription.save();

  payment.periodStart = periodStart;
  payment.periodEnd = periodEnd;
  await payment.save();

  if (payment.promotion) {
    await Promotion.updateOne({ _id: payment.promotion }, { $inc: { redemptionCount: 1 } });
  }
}

const DEFINITIVE_FAILURE_CODES = new Set(['1032', '1037', '1001', '1', '2001', '1025']);

/**
 * Re-verifies a payment directly against Safaricom's STK Push Query — the
 * safety net for whenever the async callback never arrives at all, or
 * arrived but activation didn't complete (the bug this whole reconciliation
 * path exists to recover from). Safe to call on any payment that hasn't
 * been fully activated yet, regardless of its current status: `pending`,
 * `timeout`, or a `success` whose activation silently failed.
 *
 * `receiptHint` (e.g. from a user-pasted M-Pesa SMS) is stored as the
 * receipt when Safaricom's status query itself can't supply one — unlike
 * the callback, the query response never includes the receipt number.
 */
export async function reconcilePayment(payment, { receiptHint } = {}) {
  // Subscription payments mark completion via periodEnd; seat-addition
  // payments never set it (there's no period to extend), so they're
  // considered resolved once their status says success.
  const alreadyResolved = payment.purpose === 'seat_addition' ? payment.status === 'success' : !!payment.periodEnd;
  if (alreadyResolved) {
    return { payment, changed: false };
  }

  const provider = getPaymentProvider(payment.provider);
  if (!provider.queryStatus) {
    return { payment, changed: false };
  }

  let result;
  try {
    result = await provider.queryStatus({ checkoutRequestId: payment.providerRef });
  } catch (err) {
    console.error('[Subscriptions] reconcilePayment query failed:', err.message);
    return { payment, changed: false };
  }

  if (result.success) {
    payment.status = 'success';
    payment.resultCode = result.resultCode;
    payment.errorMessage = null;
    payment.receipt = payment.receipt ?? receiptHint ?? null;
    payment.transactionDate = payment.transactionDate ?? new Date();
    await payment.save();
    await applySuccessfulPayment(payment);
    return { payment, changed: true };
  }

  if (result.resultCode && DEFINITIVE_FAILURE_CODES.has(result.resultCode)) {
    const status = result.resultCode === '1032' ? 'cancelled' : 'failed';
    payment.status = status;
    payment.resultCode = result.resultCode;
    payment.errorMessage = result.resultDesc ?? 'Payment did not complete.';
    await payment.save();
    await cleanupFailedSeatPayment(payment);
    return { payment, changed: true };
  }

  // Inconclusive (still processing on Safaricom's side, or the query itself
  // errored) — leave the payment exactly as it was; a later reconcile
  // attempt (cron or another manual recheck) will re-verify.
  return { payment, changed: false };
}

/** POST /subscriptions/pay/:paymentId/recheck — on-demand reconciliation. */
export const recheckPayment = async (req, res) => {
  try {
    const shopId = shopIdOf(req);
    const payment = await SubscriptionPayment.findOne({ _id: req.params.paymentId, shop: shopId });
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    await reconcilePayment(payment);

    return res.json({
      success: true,
      data: {
        paymentId: payment._id,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        receipt: payment.receipt ?? null,
        periodEnd: payment.periodEnd ?? null,
        errorMessage: payment.errorMessage ?? null,
      },
    });
  } catch (err) {
    console.error('[Subscriptions] recheckPayment error:', err);
    return res.status(500).json({ success: false, message: 'Failed to recheck the payment.' });
  }
};

/**
 * POST /subscriptions/reconcile — recovery path for "I paid but I'm still
 * locked out", triggered by the owner pasting their M-Pesa confirmation SMS.
 * Never trusts the pasted text on its own: it only ever re-verifies a
 * payment WE already initiated against Safaricom directly (via
 * reconcilePayment) — the pasted receipt is used to pick the right payment
 * and to record the receipt number (which the status-query API can't
 * supply), never as standalone proof.
 */
export const reconcileByMessage = async (req, res) => {
  try {
    const shopId = shopIdOf(req);
    const message = req.body.message ?? '';

    const receiptMatch = message.match(MPESA_RECEIPT_PATTERN);
    if (!receiptMatch) {
      return res.status(400).json({
        success: false,
        message: "Couldn't find an M-Pesa confirmation code in that message. Paste the full SMS from Safaricom.",
      });
    }
    const receipt = receiptMatch[1].toUpperCase();
    const amountMatch = message.match(MPESA_AMOUNT_PATTERN);
    const pastedAmount = amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : null;

    const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
    // An exact receipt match (callback already recorded it, just didn't
    // activate) beats guessing from recency.
    const candidate = await SubscriptionPayment.findOne({ shop: shopId, receipt })
      ?? await SubscriptionPayment.findOne({
        shop: shopId,
        createdAt: { $gte: since },
        $or: [{ periodEnd: { $exists: false } }, { periodEnd: null }],
      }).sort({ createdAt: -1 });

    if (!candidate) {
      return res.status(404).json({
        success: false,
        message: "We couldn't find a matching payment attempt from the last 48 hours. Start a new payment, or contact support with this M-Pesa code.",
      });
    }

    if (candidate.receipt && candidate.receipt !== receipt) {
      return res.status(409).json({
        success: false,
        message: `This code doesn't match our most recent payment attempt (receipt ${candidate.receipt}). Contact support with both codes if you believe this is wrong.`,
      });
    }
    if (pastedAmount != null && Math.abs(pastedAmount - candidate.amount) > 1) {
      return res.status(409).json({
        success: false,
        message: `That receipt is for Ksh ${pastedAmount}, but the pending payment was for Ksh ${candidate.amount}. Contact support if this looks wrong.`,
      });
    }

    await reconcilePayment(candidate, { receiptHint: receipt });

    return res.json({
      success: true,
      data: {
        paymentId: candidate._id,
        status: candidate.status,
        amount: candidate.amount,
        currency: candidate.currency,
        receipt: candidate.receipt ?? null,
        periodEnd: candidate.periodEnd ?? null,
        errorMessage: candidate.errorMessage ?? null,
      },
      message: candidate.periodEnd
        ? 'Payment verified — your subscription is active.'
        : 'We checked with M-Pesa but this payment isn’t confirmed yet. Try again in a minute.',
    });
  } catch (err) {
    console.error('[Subscriptions] reconcileByMessage error:', err);
    return res.status(500).json({ success: false, message: 'Failed to reconcile the payment.' });
  }
};
