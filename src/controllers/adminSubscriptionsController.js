import User from '../models/User.js';
import Shop from '../models/Shop.js';
import Subscription from '../models/Subscription.js';
import SubscriptionPayment from '../models/SubscriptionPayment.js';
import PlatformConfig from '../models/PlatformConfig.js';
import { deriveAccess } from '../services/subscriptionPricingService.js';
import { reconcilePayment } from './subscriptionController.js';
import { logAudit } from '../services/auditLogService.js';

/**
 * GET /admin/shops/lookup?email= — resolves a shop from an owner/staff login
 * email. Shop.email is a separate business-contact field (blank unless the
 * owner filled it in via shop settings, and never set at signup) — the
 * account's real login email lives on User, which is what support actually
 * has when a customer reports a problem with "their account".
 */
export const lookupShopByUser = async (req, res) => {
  const email = (req.query.email ?? '').toString().toLowerCase().trim();
  if (!email) {
    return res.status(400).json({ success: false, message: 'email query param is required' });
  }

  const user = await User.findOne({ email }).select('name email role shop isActive').populate('shop', 'name email').lean();
  if (!user) {
    return res.status(404).json({ success: false, message: 'No user found with that email' });
  }

  res.json({
    success: true,
    data: {
      user: { _id: user._id, name: user.name, email: user.email, role: user.role, isActive: user.isActive },
      shop: user.shop,
    },
  });
};

/**
 * GET /admin/shops/:id/subscription — subscription state plus recent payment
 * history for one shop. The read side of support diagnosing a "I paid but
 * I'm locked out" report without needing DB access: a payment stuck at
 * status 'success' with no periodEnd is exactly the silent-activation-failure
 * bug the reconcile action below exists to fix.
 */
export const getShopSubscription = async (req, res) => {
  const shop = await Shop.findById(req.params.id).lean();
  if (!shop) {
    return res.status(404).json({ success: false, message: 'Shop not found' });
  }

  const [subscription, payments, platform] = await Promise.all([
    Subscription.findOne({ shop: shop._id }).populate('plan').lean(),
    SubscriptionPayment.find({ shop: shop._id }).sort({ createdAt: -1 }).limit(20).populate('plan').lean(),
    PlatformConfig.get(),
  ]);

  res.json({
    success: true,
    data: {
      shop: { _id: shop._id, name: shop.name, email: shop.email },
      subscription,
      access: deriveAccess(subscription, platform.gracePeriodDays),
      payments,
    },
  });
};

/**
 * POST /admin/subscriptions/payments/:paymentId/reconcile — re-verifies a
 * payment directly against Safaricom and activates the subscription if it
 * actually went through. The same safety net shop owners can already
 * trigger themselves (recheck / paste-M-Pesa-SMS), exposed here so support
 * can resolve a "paid but locked out" report on the spot instead of asking
 * an engineer to run it by hand.
 */
export const reconcileShopPayment = async (req, res) => {
  const payment = await SubscriptionPayment.findById(req.params.paymentId);
  if (!payment) {
    return res.status(404).json({ success: false, message: 'Payment not found' });
  }

  const statusBefore = payment.status;
  const wasActivated = Boolean(payment.periodEnd);

  const { changed } = await reconcilePayment(payment);

  logAudit({
    shopId: payment.shop,
    action: 'admin.subscription_payment.reconciled',
    entityType: 'SubscriptionPayment',
    entityId: payment._id,
    details: {
      adminId: String(req.admin._id),
      adminEmail: req.admin.email,
      statusBefore,
      statusAfter: payment.status,
      activated: !wasActivated && Boolean(payment.periodEnd),
    },
    req,
  }).catch(() => {});

  res.json({
    success: true,
    data: {
      paymentId: payment._id,
      status: payment.status,
      periodEnd: payment.periodEnd ?? null,
      changed,
    },
  });
};

/**
 * POST /admin/shops/:id/grace-extension — grants one shop extra days before
 * it locks, on top of the platform-wide grace period.
 *
 * Support's only lever used to be changing the global gracePeriodDays for
 * every shop on the platform, or nothing at all. This is the "the owner is
 * KES 200 short until Friday" case: real, common, and not worth losing a
 * customer over. Set days to 0 to revoke an extension.
 */
export const grantGraceExtension = async (req, res) => {
  const { days, reason } = req.body;

  const subscription = await Subscription.findOne({ shop: req.params.id });
  if (!subscription) {
    return res.status(404).json({ success: false, message: 'This shop has no subscription to extend.' });
  }

  const previousDays = subscription.graceExtensionDays ?? 0;
  subscription.graceExtensionDays = days;
  subscription.graceExtensionGrantedAt = days > 0 ? new Date() : null;
  subscription.graceExtensionGrantedBy = days > 0 ? req.admin._id : null;
  subscription.graceExtensionReason = days > 0 ? (reason ?? '') : '';
  await subscription.save();

  const platform = await PlatformConfig.get();

  logAudit({
    shopId: subscription.shop,
    action: days > 0 ? 'admin.subscription.grace_extended' : 'admin.subscription.grace_revoked',
    entityType: 'Subscription',
    entityId: subscription._id,
    details: {
      adminId: String(req.admin._id),
      adminEmail: req.admin.email,
      previousDays,
      days,
      reason: reason ?? '',
    },
    req,
  }).catch(() => {});

  res.json({
    success: true,
    data: {
      graceExtensionDays: subscription.graceExtensionDays,
      access: deriveAccess(subscription.toObject(), platform.gracePeriodDays),
    },
    message: days > 0
      ? `This shop now has ${days} extra day${days === 1 ? '' : 's'} before it locks.`
      : 'Grace extension removed.',
  });
};
