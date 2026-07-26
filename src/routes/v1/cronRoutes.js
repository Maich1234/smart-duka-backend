import express from 'express';
import {
  dailySalesCheck,
  depletionAlerts,
  dailyBusinessSummary,
  subscriptionReminders,
  pushCampaignDispatch,
  subscriptionPaymentReconcile,
  accountDeletions,
} from '../../controllers/cronController.js';

const router = express.Router();

// No `protect` middleware — these are triggered by Vercel Cron, not a
// logged-in user. Each handler verifies the CRON_SECRET header itself.
router.get('/daily-sales-check', dailySalesCheck);
router.get('/depletion-alerts', depletionAlerts);
router.get('/daily-summary', dailyBusinessSummary);
router.get('/subscription-reminders', subscriptionReminders);
router.get('/push-campaign-dispatch', pushCampaignDispatch);
router.get('/subscription-payment-reconcile', subscriptionPaymentReconcile);
router.get('/account-deletions', accountDeletions);

export default router;
