import { ensureLaunchPricing } from '../services/launchPricingService.js';
import { randomUUID } from 'node:crypto';
import SubscriptionPlan from '../models/SubscriptionPlan.js';
import Subscription from '../models/Subscription.js';
import SubscriptionPayment from '../models/SubscriptionPayment.js';
import Promotion from '../models/Promotion.js';
import PlatformConfig from '../models/PlatformConfig.js';
import { YEARLY_OFFER, LAUNCH_OFFER } from '../constants/subscriptionDefaults.js';
import {
  getBillableUserCount,
  pickPlanForStaffCount,
  monthlyTotalForPlan,
  quarterlyTotalForPlan,
  yearlyTotalForPlan,
  computePrice,
  deriveAccess,
  canTransact,
} from '../services/subscriptionPricingService.js';
import {
  getAccruedSeatTotal,
  describeSeatAdjustments,
} from '../services/seatBillingService.js';
import { getPaymentProvider, listPaymentProviders } from '../domains/billing/infra/payments/index.js';
import { verifyWebhookSignature } from '../domains/billing/infra/paystackService.js';
import { withMpesaCallbackSecret } from '../services/mpesaService.js';
import { logAudit } from '../services/auditLogService.js';
import { cleanupFailedSeatPayment } from '../domains/billing/application/seatCleanup.js';
import { applySuccessfulPayment } from '../domains/billing/application/applySuccessfulPayment.js';
import { recordPaymentOutcome } from '../domains/billing/application/recordPaymentOutcome.js';
import { findUnfinishedCheckout, reserveSubscriptionCheckout } from '../domains/billing/application/reserveSubscriptionCheckout.js';
import { activateFreeSubscription } from '../domains/billing/application/activateFreeSubscription.js';
import { reconcilePayment } from '../domains/billing/application/reconcilePayment.js';
import { paystackAmountMismatch } from '../domains/billing/domain/fraud.js';
import { SUBSCRIPTION_PAGE_URL, getSubscriptionCallbackUrl } from '../domains/billing/domain/urls.js';
import { MPESA_RECEIPT_PATTERN, MPESA_AMOUNT_PATTERN } from '../utils/mpesaReceipt.js';
import { KENYAN_PHONE_PATTERN } from '../validations/subscriptionValidation.js';
import { sendPushToUser } from '../utils/push.js';
import { sendEmail } from '../utils/email.js';
import { renderSubscriptionEmail, SUBSCRIPTION_UNSUBSCRIBE_MAILTO } from '../utils/emailTemplates.js';

const shopIdOf = (req) => req.user.shop._id ?? req.user.shop;

// The provider can confirm money before activation commits. Keep the client
// waiting instead of displaying a finished receipt while access is still locked.
function paymentClientState(payment) {
  if (payment.status === 'success' && payment.purpose !== 'seat_addition' && !payment.periodEnd) {
    return { status: 'pending', errorMessage: 'Payment confirmed. We are finishing your subscription activation.' };
  }
  return { status: payment.status, errorMessage: payment.errorMessage ?? null };
}

function paymentStartData(payment) {
  return {
    paymentId: payment._id,
    ...paymentClientState(payment),
    amount: payment.amount,
    currency: payment.currency,
    billingCycle: payment.billingCycle,
    receipt: payment.receipt ?? null,
    publicKey: payment.checkoutPublicKey ?? null,
    providerRef: payment.providerRef ?? null,
    initiationState: payment.initiationState ?? null,
    provider: payment.provider,
  };
}

async function getActivePlans() {
  await ensureLaunchPricing();
  return SubscriptionPlan.find({ active: true }).sort({ displayOrder: 1 }).lean();
}

/**
 * The trial length a shop would actually get for `plan` — the plan's own
 * default, unless the shop was agent-referred and the admin has set an
 * override (see PlatformConfig.referral.agent.trialDays). Shared by getPlans
 * (so the pricing screen shows what activateTrial will actually grant,
 * before the owner commits) and activateTrial itself.
 */
async function resolveTrialDays(shop, plan) {
  if (!plan) return 30;
  if (shop?.referredByType !== 'agent') return plan.trialDays;
  const platform = await PlatformConfig.get();
  return platform.referral?.agent?.trialDays ?? plan.trialDays;
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
      const quarterlyTotal = quarterlyTotalForPlan(plan, staffCount);
      const yearlyTotal = yearlyTotalForPlan(plan, staffCount);
      return {
        ...plan,
        pricing: {
          monthlyTotal,
          quarterlyTotal,
          yearlyTotal,
          quarterlySavings: Math.max(monthlyTotal * 3 - quarterlyTotal, 0),
          yearlySavings: Math.max(monthlyTotal * 12 - yearlyTotal, 0),
        },
        recommended: recommended != null && String(plan._id) === String(recommended._id),
      };
    });

    const trialDays = await resolveTrialDays(req.user.shop, recommended);

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
    // So the preview matches what initiatePayment will actually charge —
    // otherwise a shop with banked referral credit sees a higher price here
    // than what they're charged a moment later.
    const subscription = await Subscription.findOne({ shop: shopId }).select('referralDiscountPercent');

    const price = computePrice({
      plans, plan, staffCount: Number(staffCount), billingCycle, promotion,
      referralCreditPercent: subscription?.referralDiscountPercent ?? 0,
    });
    return res.json({
      success: true,
      data: {
        planSlug: price.plan.slug,
        planName: price.plan.name,
        staffCount: price.staffCount,
        billingCycle: price.billingCycle,
        monthlyTotal: price.monthlyTotal,
        quarterlyTotal: price.quarterlyTotal,
        yearlyTotal: price.yearlyTotal,
        quarterlySavings: price.quarterlySavings,
        yearlySavings: price.yearlySavings,
        promoDiscount: price.promoDiscount,
        referralDiscount: price.referralDiscount,
        additionalCharge: price.additionalCharge,
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
    // The till (offline-first: a sale completes locally before the network
    // is ever touched, see PosScreen.tsx) has no other way to learn this
    // shop's real cutoff — read from the persisted cache, it's what stands
    // between "lock takes effect once online" and "lock never takes effect
    // while offline". Same math as requirePaidShop so the two can't drift.
    const { allowed: canSell } = canTransact(access, { subscription, platform, role: req.user.role });

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
        referralCreditPercent: subscription.referralDiscountPercent ?? 0,
      });
      // Mid-period head-count changes are postpaid — their prorated cost
      // rides on this invoice instead of having been charged on the spot.
      const seatCharges = getAccruedSeatTotal(subscription);
      renewal = {
        planSlug: price.plan.slug,
        billingCycle: price.billingCycle,
        basePrice: price.amountDue,
        additionalCharge: price.additionalCharge,
        referralDiscount: price.referralDiscount,
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
        access: { ...access, canTransact: canSell },
        gracePeriodDays: platform.gracePeriodDays,
        renewal,
      },
    });
  } catch (err) {
    console.error('[Subscriptions] getMySubscription error:', err);
    return res.status(500).json({ success: false, message: 'Failed to load subscription.' });
  }
};

const RESEND_THROTTLE_MS = 60 * 1000;

/**
 * POST /subscriptions/resend-link — owner-triggered version of the reminder
 * cron's push + email, for the paywall's "Resend payment link" button. The
 * mobile app has no purchase or checkout surface of its own (Play Store
 * policy — see SUBSCRIPTION_PAGE_URL), so this is the compliant way to
 * put the web checkout link back in front of an owner who can't find the
 * notification or email it originally went out on: the button here only
 * triggers a send through those same two channels, it never opens a URL
 * itself. Throttled against `lastReminderSentAt` so a double-tap can't spam
 * the owner's notification inbox.
 */
export const resendRenewalLink = async (req, res) => {
  try {
    const shopId = shopIdOf(req);
    const subscription = await Subscription.findOne({ shop: shopId }).populate('plan', 'name');
    if (!subscription) {
      return res.status(404).json({ success: false, message: 'This shop has no subscription yet.' });
    }

    if (subscription.lastReminderSentAt && Date.now() - subscription.lastReminderSentAt.getTime() < RESEND_THROTTLE_MS) {
      return res.json({ success: true, message: 'Already sent — check your notifications or email.' });
    }

    const platform = await PlatformConfig.get();
    const access = deriveAccess(subscription, platform.gracePeriodDays);
    const what = access.state === 'trialing' ? 'free trial' : 'subscription';
    const shopName = req.user.shop?.name;

    const title = 'Your DuQana payment link';
    const pushBody = 'Tap to renew your subscription and keep your shop running.';
    const emailMessage =
      access.state === 'grace'
        ? `Your ${what} has ended. You have ${access.graceDaysLeft} day${access.graceDaysLeft === 1 ? '' : 's'} left before ${shopName || 'your shop'} pauses — renew below to keep selling without interruption.`
        : access.state === 'locked'
          ? `Your ${what} has ended and ${shopName || 'your shop'} is currently paused. Nothing has been deleted — renew below and you're back online immediately.`
          : `Tap below to renew your DuQana ${what} and keep ${shopName || 'your shop'} running.`;

    // Push and email are independent channels — a failure in one must not
    // block or misreport the other (this used to silently swallow email
    // failures and always tell the caller "Sent").
    let pushSent = true;
    try {
      await sendPushToUser(req.user, {
        title,
        body: pushBody,
        data: { type: 'subscription_reminder', kind: 'resend', actionUrl: SUBSCRIPTION_PAGE_URL },
      });
    } catch (err) {
      pushSent = false;
      console.error('[Subscriptions] resendRenewalLink push failed for', String(req.user._id), '-', err.message);
    }

    let emailSent = false;
    if (req.user.email) {
      const { html, text } = renderSubscriptionEmail({
        preheader: emailMessage,
        ownerName: req.user.name,
        shopName,
        heading: access.state === 'grace' || access.state === 'locked' ? `Renew to keep ${shopName || 'your shop'} running` : 'Your DuQana renewal link',
        message: emailMessage,
        detailRows: [
          { label: 'Shop', value: shopName },
          { label: 'Plan', value: subscription.plan?.name },
        ],
        ctaLabel: 'Renew now',
        ctaUrl: SUBSCRIPTION_PAGE_URL,
      });
      try {
        await sendEmail(req.user.email, title, html, text, {
          'List-Unsubscribe': `<${SUBSCRIPTION_UNSUBSCRIBE_MAILTO}>`,
        });
        emailSent = true;
      } catch (err) {
        console.error('[Subscriptions] resendRenewalLink email failed for', req.user.email, '-', err.message);
      }
    }

    if (!pushSent && !emailSent) {
      return res.status(502).json({ success: false, message: 'Could not send the payment link right now — please try again shortly.' });
    }

    subscription.lastReminderSentAt = new Date();
    await subscription.save();

    const message = emailSent
      ? 'Sent — check your notifications or email.'
      : req.user.email
        ? 'Sent to your notifications. The email is delayed — check back shortly, or look in your spam folder.'
        : 'Sent — check your notifications.';

    return res.json({ success: true, emailSent, message });
  } catch (err) {
    console.error('[Subscriptions] resendRenewalLink error:', err);
    return res.status(500).json({ success: false, message: 'Failed to send the payment link.' });
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

    // Agent-referred shops get an admin-configurable trial length instead of
    // the plan's default — set to 0 to require immediate payment. Every
    // other shop is unaffected. Same resolution getPlans already showed the
    // owner on the pricing screen, so this never surprises them.
    const trialDays = await resolveTrialDays(req.user.shop, plan);

    const now = new Date();
    const trialEnd = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

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
      details: { planSlug: plan.slug, trialDays, staffCount },
      req,
    }).catch(() => {});

    subscription = await subscription.populate('plan');
    return res.status(201).json({
      success: true,
      data: { subscription, alreadyActivated: false, trialEnd },
      message: trialDays > 0
        ? `Your free ${trialDays}-day trial is active.`
        : 'Your trial period requires payment to activate — please subscribe to continue.',
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
    const rawKey = req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'];
    if (rawKey != null && (typeof rawKey !== 'string' || !rawKey.trim() || rawKey.length > 128)) {
      return res.status(400).json({ success: false, message: 'Payment request key must be between 1 and 128 characters.' });
    }
    // A compound sparse index still indexes a missing key when shop exists.
    // Every attempt needs a value; callers supplying a key retain replay safety.
    const idempotencyKey = rawKey?.trim() ?? `auto:${randomUUID()}`;

    // ── 1. Idempotency: a retry must never fire a second STK push ──────────
    if (idempotencyKey) {
      const existing = await SubscriptionPayment.findOne({ shop: shopId, idempotencyKey });
      if (existing) {
        return res.json({
          success: true,
          idempotent: true,
          data: paymentStartData(existing),
          message: paymentClientState(existing).status === 'pending'
            ? 'This payment is being processed. Check its status before starting another.'
            : `Duplicate request — payment already ${paymentClientState(existing).status}.`,
        });
      }
    }

    const unfinished = await findUnfinishedCheckout(shopId);
    if (unfinished) return res.json({
      success: true, idempotent: true, data: paymentStartData(unfinished),
      message: 'Please finish checking your existing payment before starting another.',
    });

    // ── 2. Resolve subscription, plan, and server-side price ───────────────
    let subscription = await Subscription.findOne({ shop: shopId });
    const plans = await getActivePlans();
    const staffCount = await getBillableUserCount(shopId);
    let plan = planSlug
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

    const price = computePrice({
      plans, plan, staffCount, billingCycle, promotion,
      referralCreditPercent: subscription?.referralDiscountPercent ?? 0,
    });
    plan = price.plan;
    // Accrued mid-period seat changes settle on this invoice. Added after the
    // promotion so a discount code applies to the plan price, not to seats
    // already consumed.
    const seatCharges = getAccruedSeatTotal(subscription);
    const amountDue = price.amountDue + seatCharges;

    // A shop that skipped the trial can still pay (or activate for free):
    // create its subscription shell now regardless of amountDue; the
    // successful payment flips it to active either way.
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

    // A promo/referral discount fully covering the invoice: nothing to
    // charge, so no payment provider is ever involved. amountDue is entirely
    // server-computed above (plan price, promo, referral credit, seat
    // charges) — nothing here is trusted from the client.
    if (amountDue <= 0) {
      try {
        const { payment, created } = await activateFreeSubscription({
          shopId, subscription, plan, billingCycle, staffCount, price, promotion,
          requestedBy: req.user._id, idempotencyKey, req,
          seatAdjustmentIds: subscription.seatAdjustments.map(a => a._id),
        });
        return res.status(created ? 201 : 200).json({
          success: true,
          idempotent: !created,
          data: paymentStartData(payment),
          message: paymentClientState(payment).status === 'success'
            ? 'Your subscription is active.'
            : 'Please finish checking your existing payment before starting another.',
        });
      } catch (err) {
        // Idempotency-race recovery, same pattern as the charged path below.
        if (err.code === 11000 && idempotencyKey) {
          const existing = await SubscriptionPayment.findOne({ shop: shopId, idempotencyKey });
          if (existing) {
            return res.json({
              success: true,
              idempotent: true,
              data: { paymentId: existing._id, ...paymentClientState(existing), amount: existing.amount },
              message: paymentClientState(existing).status === 'success' ? 'Already activated.' : `Duplicate request — payment already ${paymentClientState(existing).status}.`,
            });
          }
        }
        if (err.code === 'PROMOTION_UNAVAILABLE') {
          return res.status(400).json({ success: false, message: err.message });
        }
        console.error('[Subscriptions] activateFreeSubscription error:', err);
        return res.status(500).json({ success: false, message: 'Could not activate the subscription. Please try again.' });
      }
    }

    // Validate configuration before reserving an attempt; these reads do not
    // contact a payment network. Bank checkout does not need an M-Pesa URL.
    const provider = getPaymentProvider(providerKey);
    if (!provider.available) return res.status(400).json({ success: false, message: 'This payment method is not available yet.' });
    let callbackUrl;
    if (provider.key === 'mpesa') {
      callbackUrl = withMpesaCallbackSecret(getSubscriptionCallbackUrl());
      if (!callbackUrl) return res.status(503).json({ success: false, message: 'M-Pesa callbacks are not configured. Please contact support.' });
      if (!KENYAN_PHONE_PATTERN.test(phoneNumber ?? '')) return res.status(400).json({ success: false, message: 'Phone number must be in +2547XXXXXXXX or +2541XXXXXXXX format' });
      // Fail before dispatch/reservation for invalid server URL configuration.
      callbackUrl = new URL(callbackUrl);
    }
    let config;
    try {
      config = await provider.getConfig?.();
    } catch (err) {
      console.error('[Subscriptions] provider configuration unavailable:', err.message);
      return res.status(503).json({ success: false, message: 'This payment method is temporarily unavailable. Please contact support.' });
    }

    // Reserve the unique intent BEFORE touching the provider. The database
    // winner alone dispatches; concurrent callers replay this same attempt.
    const reservedRef = provider.key === 'bank' ? `DKN-${randomUUID()}` : undefined;
    let payment;
    try {
      const reservation = await reserveSubscriptionCheckout({
        shop: shopId,
        subscription: subscription._id,
        plan: plan._id,
        billingCycle,
        staffCount,
        amount: amountDue,
        seatAdjustmentIds: subscription.seatAdjustments.map(a => a._id),
        currency: price.currency,
        provider: provider.key,
        providerRef: reservedRef,
        checkoutPublicKey: provider.key === 'bank' ? config.publicKey : undefined,
        phoneNumber,
        status: 'pending',
        initiationState: 'starting',
        promotion: promotion?._id ?? null,
        promoCode: promotion?.code ?? null,
        promoDiscount: price.promoDiscount,
        referralDiscount: price.referralDiscount,
        additionalCharge: price.additionalCharge,
        requestedBy: req.user._id,
        idempotencyKey,
      });
      payment = reservation.payment;
      if (!reservation.created) return res.json({
        success: true, idempotent: true, data: paymentStartData(payment),
        message: 'Please finish checking your existing payment before starting another.',
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
      const existing = await SubscriptionPayment.findOne({ shop: shopId, idempotencyKey });
      if (!existing) throw err;
      return res.json({ success: true, idempotent: true, data: paymentStartData(existing), message: 'This payment is already being processed. Check its status before starting another.' });
    }

    if (callbackUrl) callbackUrl.pathname = `${callbackUrl.pathname.replace(/\/+$/, '')}/${payment._id}`;
    let charge;
    try {
      charge = await provider.charge({
        phoneNumber,
        amount: amountDue,
        reference: reservedRef ?? 'DUKANA',
        description: `DuQana ${plan.name} (${billingCycle})`,
        callbackUrl: callbackUrl?.toString(),
        email: req.user.email,
      });
      if (!charge?.providerRef) throw new Error('Provider did not return a payment reference.');
    } catch (err) {
      console.error('[Subscriptions] provider initiation uncertain:', err.message);
      // A network error is not proof that the provider did nothing. Keep the
      // intent and return its ID; never automatically repeat the dispatch.
      try {
        await SubscriptionPayment.updateOne(
          { _id: payment._id, status: 'pending' },
          { $set: { initiationState: 'uncertain', errorMessage: 'We could not confirm the payment request. Check this payment before starting another.' } },
        );
        payment = await SubscriptionPayment.findById(payment._id) ?? payment;
      } catch (storageError) {
        console.error('[Subscriptions] could not refresh reserved payment:', storageError.message);
      }
      return res.status(paymentClientState(payment).status === 'pending' ? 202 : 200).json({ success: true, data: paymentStartData(payment), message: 'Check this payment’s recorded status before starting another request.' });
    }
    // Do not save a stale pending status over an early successful callback.
    try {
      const updated = await SubscriptionPayment.findOneAndUpdate(
        { _id: payment._id, $or: [{ providerRef: null }, { providerRef: charge.providerRef }] },
        { $set: {
          providerRef: charge.providerRef,
          merchantRequestId: charge.merchantRequestId,
          phoneNumber: charge.phoneNumber ?? phoneNumber,
          checkoutPublicKey: charge.publicKey,
          initiationState: 'submitted',
        } },
        { new: true },
      );
      if (!updated) throw new Error('Provider returned a conflicting payment reference.');
      payment = updated;
    } catch (storageError) {
      console.error('[Subscriptions] could not finish reserved payment:', storageError.message);
      // The provider may already have accepted the request. Preserve its
      // durable attempt ID in the response even if this metadata write fails.
      return res.status(202).json({
        success: true,
        data: paymentStartData(payment),
        message: 'Your payment request is recorded. Check its status before starting another.',
      });
    }

    logAudit({
      shopId,
      userId: req.user._id,
      action: 'subscription.payment.initiated',
      entityType: 'SubscriptionPayment',
      entityId: payment._id,
      details: {
        amount: amountDue, seatCharges, billingCycle, planSlug: plan.slug, provider: provider.key,
        promoCode: promotion?.code, referralDiscount: price.referralDiscount || undefined,
      },
      req,
    }).catch(() => {});

    return res.status(201).json({
      success: true,
      data: { ...paymentStartData(payment), planSlug: plan.slug },
      message: paymentClientState(payment).status === 'success'
        ? 'Payment confirmed — your subscription is active.'
        : provider.key === 'mpesa'
          ? 'Payment request sent. Enter your M-PESA PIN on your phone to finish.'
          : 'Payment started.',
    });
  } catch (err) {
    console.error('[Subscriptions] initiatePayment error:', err);
    return res.status(500).json({ success: false, message: 'An unexpected error occurred while starting the payment.' });
  }
};

/** GET /subscriptions/checkout — owner recovery across browsers and sessions. */
export const getUnfinishedCheckout = async (req, res) => {
  try {
    const payment = await findUnfinishedCheckout(shopIdOf(req));
    return res.json({ success: true, data: { checkout: payment ? paymentStartData(payment) : null } });
  } catch (err) {
    console.error('[Subscriptions] checkout recovery failed:', err.message);
    return res.status(503).json({ success: false, message: 'Could not check your previous payment. Please try again.' });
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

    // Reading a payment must not turn a slow provider response into a
    // persisted failure. A client can stop polling without expiring payment.

    return res.json({
      success: true,
      data: {
        paymentId: payment._id,
        ...paymentClientState(payment),
        provider: payment.provider,
        amount: payment.amount,
        additionalCharge: payment.additionalCharge ?? 0,
        currency: payment.currency,
        receipt: payment.receipt ?? null,
        periodEnd: payment.periodEnd ?? null,
      },
    });
  } catch (err) {
    console.error('[Subscriptions] getPaymentStatus error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch payment status.' });
  }
};

/**
 * POST /subscriptions/mpesa/callback — Safaricom webhook, public (no JWT).
 * Records authenticated provider results without downgrading confirmed success,
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

    if (typeof parsed.providerRef !== 'string' || !parsed.providerRef.trim()) {
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }
    let candidate;
    if (req.params.paymentId) {
      if (!/^[a-f\d]{24}$/i.test(req.params.paymentId)) return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
      candidate = await SubscriptionPayment.findOne({
        _id: req.params.paymentId,
        provider: 'mpesa',
        $or: [
          { providerRef: parsed.providerRef },
          { providerRef: null, initiationState: { $in: ['starting', 'uncertain'] } },
        ],
      });
    } else {
      candidate = await SubscriptionPayment.findOne({ provider: 'mpesa', providerRef: parsed.providerRef });
    }
    if (!candidate) return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    const { payment, changed } = await recordPaymentOutcome(candidate._id, {
      status,
      providerRef: parsed.providerRef,
      initiationState: 'submitted',
      resultCode: parsed.resultCode,
      errorMessage: parsed.success ? null : parsed.resultDesc,
      receipt: parsed.receipt,
      ...(parsed.success && { transactionDate: new Date() }),
      callbackPayload: req.body,
      callbackReceivedAt: new Date(),
    });
    if (!payment) return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    if (payment.status === 'success') {
      // Includes late confirmations and retries after an activation failure.
      if (!payment.periodEnd) await applySuccessfulPayment(payment);
    } else if (changed) {
      await cleanupFailedSeatPayment(payment);
    }
    if (!changed) return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

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
    // Do not acknowledge an activation we failed to finish. Re-delivery is
    // safe: the confirmed result and atomic activation marker are retained.
    return res.status(503).json({ ResultCode: 1, ResultDesc: 'Processing incomplete. Please retry.' });
  }
};

/**
 * POST /subscriptions/paystack/webhook — Paystack's webhook, public (no
 * JWT). Same guarded outcome + idempotent-activation shape as
 * handleMpesaCallback; only `charge.success` is acted on, everything else
 * (refunds, transfers, etc.) is accepted and ignored.
 */
export const handlePaystackWebhook = async (req, res) => {
  try {
    const provider = getPaymentProvider('bank');
    const signature = req.headers['x-paystack-signature'];
    let config;
    try {
      config = await provider.getConfig();
    } catch (err) {
      console.error('[Paystack Webhook] Not configured:', err.message);
      return res.status(200).json({ received: true });
    }
    if (!verifyWebhookSignature({ rawBody: req.rawBody, signature, secretKey: config.secretKey })) {
      console.error('[Paystack Webhook] Invalid signature');
      return res.status(401).json({ message: 'Invalid signature' });
    }

    const parsed = provider.parseCallback(req.body);
    if (req.body?.event !== 'charge.success') {
      return res.status(200).json({ received: true });
    }

    if (typeof parsed.providerRef !== 'string' || !parsed.providerRef.trim()) {
      return res.status(200).json({ received: true });
    }
    const candidate = await SubscriptionPayment.findOne({ provider: 'bank', providerRef: parsed.providerRef });
    if (!candidate) return res.status(200).json({ received: true });
    // Check the amount before recording success, including late callbacks.
    const mismatch = paystackAmountMismatch(candidate, parsed.amountKobo, parsed.currency);
    const { payment, changed } = await recordPaymentOutcome(candidate._id, {
      status: mismatch ? 'failed' : 'success',
      resultCode: parsed.resultCode,
      errorMessage: mismatch ?? null,
      ...(!mismatch && { receipt: parsed.receipt, transactionDate: new Date() }),
      callbackPayload: req.body,
      callbackReceivedAt: new Date(),
    });
    if (!payment) return res.status(200).json({ received: true });
    if (payment.status === 'success' && !payment.periodEnd) await applySuccessfulPayment(payment);
    if (!changed) return res.status(200).json({ received: true });
    if (mismatch) {
      console.error('[Paystack Webhook]', mismatch, 'payment', String(payment._id));
      return res.status(200).json({ received: true });
    }

    logAudit({
      shopId: payment.shop,
      action: 'subscription.payment.success',
      entityType: 'SubscriptionPayment',
      entityId: payment._id,
      details: { resultCode: parsed.resultCode, receipt: parsed.receipt, amount: payment.amount },
    }).catch(() => {});

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[Paystack Webhook] Processing error:', err.message);
    // Let the provider retry rather than acknowledging incomplete processing.
    return res.status(503).json({ received: false });
  }
};

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
        ...paymentClientState(payment),
        provider: payment.provider,
        amount: payment.amount,
        additionalCharge: payment.additionalCharge ?? 0,
        currency: payment.currency,
        receipt: payment.receipt ?? null,
        periodEnd: payment.periodEnd ?? null,
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
    const candidate = await SubscriptionPayment.findOne({ shop: shopId, provider: 'mpesa', receipt })
      ?? await SubscriptionPayment.findOne({
        shop: shopId,
        provider: 'mpesa',
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
        ...paymentClientState(candidate),
        provider: candidate.provider,
        amount: candidate.amount,
        currency: candidate.currency,
        receipt: candidate.receipt ?? null,
        periodEnd: candidate.periodEnd ?? null,
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
