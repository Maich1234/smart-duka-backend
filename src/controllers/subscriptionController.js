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

    const price = computePrice({
      plans, plan, staffCount, billingCycle, promotion,
      referralCreditPercent: subscription?.referralDiscountPercent ?? 0,
    });
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
        const payment = await activateFreeSubscription({
          shopId, subscription, plan, billingCycle, staffCount, price, promotion,
          requestedBy: req.user._id, idempotencyKey, req,
        });
        return res.status(201).json({
          success: true,
          data: {
            paymentId: payment._id,
            status: 'success',
            amount: 0,
            currency: price.currency,
            billingCycle,
            planSlug: plan.slug,
            publicKey: null,
            providerRef: null,
          },
          message: 'Your promo code covers the full amount — subscription activated for free.',
        });
      } catch (err) {
        // Idempotency-race recovery, same pattern as the charged path below.
        if (err.code === 11000 && idempotencyKey) {
          const existing = await SubscriptionPayment.findOne({ shop: shopId, idempotencyKey });
          if (existing) {
            return res.json({
              success: true,
              idempotent: true,
              data: { paymentId: existing._id, status: existing.status, amount: existing.amount },
              message: existing.status === 'success' ? 'Already activated.' : `Duplicate request — payment already ${existing.status}.`,
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

    // ── 3. Charge via the provider abstraction ─────────────────────────────
    const callbackUrl = withMpesaCallbackSecret(getSubscriptionCallbackUrl());
    if (!callbackUrl) {
      return res.status(503).json({
        success: false,
        message: 'SUBSCRIPTION_MPESA_CALLBACK_URL or MPESA_CALLBACK_SECRET is not configured on the server. Contact the app administrator.',
      });
    }

    const provider = getPaymentProvider(providerKey);
    if (provider.key === 'mpesa' && !KENYAN_PHONE_PATTERN.test(phoneNumber ?? '')) {
      return res.status(400).json({ success: false, message: 'Phone number must be in +2547XXXXXXXX or +2541XXXXXXXX format' });
    }
    let charge;
    try {
      charge = await provider.charge({
        phoneNumber,
        amount: amountDue,
        reference: 'DUKANA',
        description: `DuQana ${plan.name} (${billingCycle})`,
        callbackUrl,
        email: req.user.email,
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
        referralDiscount: price.referralDiscount,
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
      details: {
        amount: amountDue, seatCharges, billingCycle, planSlug: plan.slug, provider: provider.key,
        promoCode: promotion?.code, referralDiscount: price.referralDiscount || undefined,
      },
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
        // Paystack only: the client opens its own popup against this key and
        // reference. Absent (null) for providers that push a prompt
        // server-side instead, like M-Pesa's STK push.
        publicKey: charge.publicKey ?? null,
        providerRef: charge.providerRef,
      },
      message: provider.key === 'mpesa'
        ? 'Payment request sent. Enter your M-PESA PIN on your phone to finish.'
        : 'Payment started.',
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
 * POST /subscriptions/paystack/webhook — Paystack's webhook, public (no
 * JWT). Same atomic-claim + idempotent-activation shape as
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

    // Atomic claim: only one delivery can move the payment out of 'pending'.
    const payment = await SubscriptionPayment.findOneAndUpdate(
      { providerRef: parsed.providerRef, status: 'pending' },
      {
        $set: {
          status: 'success',
          resultCode: parsed.resultCode,
          errorMessage: null,
          receipt: parsed.receipt,
          transactionDate: new Date(),
          callbackPayload: req.body,
          callbackReceivedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!payment) {
      console.error('[Paystack Webhook] Unknown or already-settled reference:', parsed.providerRef);
      return res.status(200).json({ received: true });
    }

    const mismatch = paystackAmountMismatch(payment, parsed.amountKobo);
    if (mismatch) {
      payment.status = 'failed';
      payment.errorMessage = mismatch;
      await payment.save();
      console.error('[Paystack Webhook]', mismatch, 'payment', String(payment._id));
      return res.status(200).json({ received: true });
    }

    await applySuccessfulPayment(payment);

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
    // Still 200 — a non-200 makes Paystack retry, which would just replay
    // the same (already-logged) failure. The cron reconciliation and the
    // owner-facing recheck endpoint are the real recovery path.
    return res.status(200).json({ received: true });
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
