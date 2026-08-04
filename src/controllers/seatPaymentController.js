import User from '../models/User.js';
import Subscription from '../models/Subscription.js';
import SubscriptionPayment from '../models/SubscriptionPayment.js';
import { DEFAULT_STAFF_PERMISSIONS, withImpliedPermissions } from '../constants/permissions.js';
import { getBillableUserCount, computeSeatAdditionImpact } from '../services/subscriptionPricingService.js';
import { getPaymentProvider } from '../services/payments/index.js';
import { cleanupFailedSeatPayment } from '../services/seatActivationService.js';
import { getSubscriptionCallbackUrl, reconcilePayment } from './subscriptionController.js';
import { logAudit } from '../services/auditLogService.js';
import { MPESA_RECEIPT_PATTERN, MPESA_AMOUNT_PATTERN } from '../utils/mpesaReceipt.js';
import { isSystemGeneratedEmail } from '../utils/staffEmailSlug.js';
import { sendVerificationEmail } from '../utils/emailVerification.js';

const UNRESOLVED_STATUSES = ['pending', 'timeout'];
const STALE_PENDING_MS = 2 * 60 * 1000;

/**
 * Frees up a staff email for (re)use, or blocks on a genuinely in-flight
 * seat payment. An inactive User row is either a paid seat awaiting webhook
 * confirmation (leave it alone, block a second charge) or an abandoned one
 * from a payment that never completed (reclaim it so the owner isn't locked
 * out of reusing that email).
 */
export async function resolveStaffEmailSlot(email) {
  const existingUser = await User.findOne({ email });
  if (!existingUser) return;

  if (existingUser.isActive) {
    const err = new Error('Email already exists');
    err.status = 400;
    throw err;
  }

  const payment = await SubscriptionPayment.findOne({
    pendingStaff: existingUser._id,
    purpose: 'seat_addition',
  }).sort({ createdAt: -1 });

  const isStale = !payment
    || !UNRESOLVED_STATUSES.includes(payment.status)
    || Date.now() - new Date(payment.createdAt).getTime() > STALE_PENDING_MS;

  if (isStale) {
    await existingUser.deleteOne();
    return;
  }

  const err = new Error('A payment for this email is already being processed.');
  err.status = 409;
  err.code = 'SEAT_PAYMENT_IN_PROGRESS';
  throw err;
}

function staffPublicView(user) {
  const obj = user.toObject();
  delete obj.password;
  return obj;
}

/**
 * POST /staff/seat-payment — starts (or short-circuits) the purchase of one
 * additional staff seat. Re-derives the price impact server-side; the 409 a
 * client saw from createStaff is only ever a hint, never trusted here.
 */
export const initiateSeatPayment = async (req, res) => {
  try {
    const { email, phoneNumber, permissions } = req.body;

    try {
      await resolveStaffEmailSlot(email);
    } catch (err) {
      return res.status(err.status ?? 500).json({ success: false, code: err.code, message: err.message });
    }

    const shopId = req.user.shop._id;
    const subscription = await Subscription.findOne({ shop: shopId }).populate('plan');
    if (!subscription?.plan) {
      return res.status(400).json({ success: false, message: 'No active subscription to add a seat to.' });
    }

    const currentStaffCount = await getBillableUserCount(shopId);
    const impact = computeSeatAdditionImpact(subscription.plan, currentStaffCount, subscription.billingCycle);

    // Seat count changed since the client saw its 409 (e.g. someone else was
    // just removed) — it's free now, no charge needed.
    if (!impact.increased) {
      const isEmailVerified = isSystemGeneratedEmail(email, req.user.shop.name);
      const staff = await User.create({
        ...req.body,
        role: 'staff',
        shop: shopId,
        isActive: true,
        isEmailVerified,
        permissions: withImpliedPermissions(permissions ?? DEFAULT_STAFF_PERMISSIONS),
      });
      if (!isEmailVerified) {
        sendVerificationEmail(staff).catch((err) => console.error('[SeatPayment] verification email failed:', err.message));
      }
      return res.status(201).json({ success: true, data: { mode: 'created', staff: staffPublicView(staff) } });
    }

    const amount = impact.projectedAmount - impact.currentAmount;

    // Reserve the email and keep the seat inert until payment succeeds. The
    // verification email (if this isn't a system-generated address) is sent
    // once activateSeatPayment() actually activates the staff — sending it
    // now would orphan an invite if the payment fails or times out.
    const pendingStaff = await User.create({
      ...req.body,
      role: 'staff',
      shop: shopId,
      isActive: false,
      isEmailVerified: isSystemGeneratedEmail(email, req.user.shop.name),
      permissions: withImpliedPermissions(permissions ?? DEFAULT_STAFF_PERMISSIONS),
    });

    const callbackUrl = getSubscriptionCallbackUrl();
    if (!callbackUrl) {
      await pendingStaff.deleteOne();
      return res.status(503).json({
        success: false,
        message: 'SUBSCRIPTION_MPESA_CALLBACK_URL is not configured on the server. Contact the app administrator.',
      });
    }

    const provider = getPaymentProvider('mpesa');
    let charge;
    try {
      charge = await provider.charge({
        phoneNumber,
        amount,
        reference: 'DUKANA',
        description: `Dukana — add staff seat (${subscription.plan.name})`,
        callbackUrl,
      });
    } catch (err) {
      await pendingStaff.deleteOne();
      if (err.code === 'PROVIDER_UNAVAILABLE') {
        return res.status(400).json({ success: false, message: err.message });
      }
      if (err.code === 'PLATFORM_PAYMENTS_UNCONFIGURED') {
        return res.status(503).json({ success: false, message: err.message });
      }
      console.error('[SeatPayment] charge failed:', err.message);
      return res.status(503).json({
        success: false,
        message: 'Could not reach M-PESA to start the payment. Please try again in a moment.',
      });
    }

    const payment = await SubscriptionPayment.create({
      shop: shopId,
      subscription: subscription._id,
      plan: subscription.plan._id,
      billingCycle: subscription.billingCycle,
      staffCount: currentStaffCount + 1,
      amount,
      currency: subscription.plan.currency,
      provider: provider.key,
      providerRef: charge.providerRef,
      merchantRequestId: charge.merchantRequestId,
      phoneNumber: charge.phoneNumber ?? phoneNumber,
      status: 'pending',
      purpose: 'seat_addition',
      pendingStaff: pendingStaff._id,
      requestedBy: req.user._id,
    });

    logAudit({
      shopId,
      userId: req.user._id,
      action: 'staff.seatPayment.initiated',
      entityType: 'SubscriptionPayment',
      entityId: payment._id,
      details: { amount, email },
      req,
    }).catch(() => {});

    return res.status(201).json({
      success: true,
      data: { mode: 'payment_pending', paymentId: payment._id, amount, currency: subscription.plan.currency },
      message: 'Payment request sent. Enter your M-PESA PIN on your phone to finish.',
    });
  } catch (err) {
    console.error('[SeatPayment] initiateSeatPayment error:', err);
    return res.status(500).json({ success: false, message: 'An unexpected error occurred while starting the payment.' });
  }
};

async function paymentStateResponse(payment) {
  let staff = null;
  if (payment.status === 'success' && payment.pendingStaff) {
    const staffDoc = await User.findById(payment.pendingStaff).select('-password');
    staff = staffDoc?.toObject() ?? null;
  }
  return {
    paymentId: payment._id,
    status: payment.status,
    amount: payment.amount,
    currency: payment.currency,
    receipt: payment.receipt ?? null,
    errorMessage: payment.errorMessage ?? null,
    staff,
  };
}

/** GET /staff/seat-payment/:paymentId — polls a pending seat charge. */
export const getSeatPaymentStatus = async (req, res) => {
  try {
    const shopId = req.user.shop._id;
    const payment = await SubscriptionPayment.findOne({
      _id: req.params.paymentId,
      shop: shopId,
      purpose: 'seat_addition',
    });
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    if (payment.status === 'pending') {
      const ageMs = Date.now() - new Date(payment.createdAt).getTime();
      if (ageMs > STALE_PENDING_MS) {
        payment.status = 'timeout';
        payment.errorMessage = 'The payment request expired before it was confirmed.';
        await payment.save();
        await cleanupFailedSeatPayment(payment);
      }
    }

    return res.json({ success: true, data: await paymentStateResponse(payment) });
  } catch (err) {
    console.error('[SeatPayment] getSeatPaymentStatus error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch payment status.' });
  }
};

/** POST /staff/seat-payment/:paymentId/recheck — on-demand reconciliation. */
export const recheckSeatPayment = async (req, res) => {
  try {
    const shopId = req.user.shop._id;
    const payment = await SubscriptionPayment.findOne({
      _id: req.params.paymentId,
      shop: shopId,
      purpose: 'seat_addition',
    });
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }

    await reconcilePayment(payment);

    return res.json({ success: true, data: await paymentStateResponse(payment) });
  } catch (err) {
    console.error('[SeatPayment] recheckSeatPayment error:', err);
    return res.status(500).json({ success: false, message: 'Failed to recheck the payment.' });
  }
};

/**
 * POST /staff/seat-payment/reconcile — recovery path for "I paid but the
 * staff member is still stuck inactive", same shape as the subscription
 * equivalent (reconcileByMessage in subscriptionController.js): the owner
 * pastes their M-Pesa confirmation SMS, which is only ever used to pick the
 * right pending payment and supply its receipt — never trusted as proof on
 * its own. reconcilePayment always re-verifies against M-Pesa directly.
 */
export const reconcileSeatPaymentByMessage = async (req, res) => {
  try {
    const shopId = req.user.shop._id;
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
    const candidate = await SubscriptionPayment.findOne({ shop: shopId, purpose: 'seat_addition', receipt })
      ?? await SubscriptionPayment.findOne({
        shop: shopId,
        purpose: 'seat_addition',
        createdAt: { $gte: since },
        status: { $in: UNRESOLVED_STATUSES },
      }).sort({ createdAt: -1 });

    if (!candidate) {
      return res.status(404).json({
        success: false,
        message: "We couldn't find a matching seat payment attempt from the last 48 hours. Start a new one, or contact support with this M-Pesa code.",
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
      data: await paymentStateResponse(candidate),
      message: candidate.status === 'success'
        ? 'Payment verified — your staff member is active.'
        : 'We checked with M-Pesa but this payment isn’t confirmed yet. Try again in a minute.',
    });
  } catch (err) {
    console.error('[SeatPayment] reconcileSeatPaymentByMessage error:', err);
    return res.status(500).json({ success: false, message: 'Failed to reconcile the payment.' });
  }
};
