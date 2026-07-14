import Shop from '../models/Shop.js';
import Subscription from '../models/Subscription.js';
import SubscriptionPayment from '../models/SubscriptionPayment.js';
import PlatformConfig from '../models/PlatformConfig.js';
import { deriveAccess } from '../services/subscriptionPricingService.js';
import { reconcilePayment } from './subscriptionController.js';
import { logAudit } from '../services/auditLogService.js';

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
