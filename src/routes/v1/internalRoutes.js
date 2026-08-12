import express from 'express';
import { protectInternal } from '../../middlewares/internalAuth.js';
import SubscriptionPayment from '../../models/SubscriptionPayment.js';
import { reconcilePayment } from '../../controllers/subscriptionController.js';
import { claimAndDispatchCampaign } from '../../services/pushCampaignService.js';

const router = express.Router();

// Service-to-service only — called by dukana-admin-backend, which owns the
// admin identity and does its own audit logging on the result this returns.
// These two actions can't be a plain cross-DB write from the admin backend
// because they call out to Safaricom/Firebase with credentials and SDKs that
// only live here; wrapping the existing, already-tested functions is safer
// than re-implementing those integrations in a second codebase.
router.use(protectInternal);

/**
 * POST /internal/subscriptions/payments/:paymentId/reconcile — same action
 * as the former admin-panel reconcile button, now callable cross-service.
 */
router.post('/subscriptions/payments/:paymentId/reconcile', async (req, res) => {
  const payment = await SubscriptionPayment.findById(req.params.paymentId);
  if (!payment) {
    return res.status(404).json({ success: false, message: 'Payment not found' });
  }

  const statusBefore = payment.status;
  const wasActivated = Boolean(payment.periodEnd);

  const { changed } = await reconcilePayment(payment);

  res.json({
    success: true,
    data: {
      paymentId: payment._id,
      shopId: payment.shop,
      statusBefore,
      status: payment.status,
      periodEnd: payment.periodEnd ?? null,
      activated: !wasActivated && Boolean(payment.periodEnd),
      changed,
    },
  });
});

/**
 * POST /internal/push-campaigns/:id/dispatch — same action as the former
 * admin-panel "Send now" button.
 */
router.post('/push-campaigns/:id/dispatch', async (req, res) => {
  const campaign = await claimAndDispatchCampaign(req.params.id);
  if (!campaign) {
    return res.status(409).json({
      success: false,
      message: 'Campaign is not in a sendable state (already sending, sent, or cancelled).',
    });
  }
  res.json({ success: true, data: campaign });
});

export default router;
