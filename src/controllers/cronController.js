import Shop from '../models/Shop.js';
import User from '../models/User.js';
import NotificationLog from '../models/NotificationLog.js';
import Subscription from '../models/Subscription.js';
import SubscriptionPayment from '../models/SubscriptionPayment.js';
import PlatformConfig from '../models/PlatformConfig.js';
import PushCampaign from '../models/PushCampaign.js';
import { sendPushToUser } from '../utils/push.js';
import { getDepletionAnalytics } from '../services/depletionService.js';
import { generateDailySummary } from '../services/dailySummaryService.js';
import { dueReminder } from '../services/subscriptionPricingService.js';
import { detectSalesAnomaly } from '../services/intelligence/salesAnomalyService.js';
import { claimAndDispatchCampaign } from '../services/pushCampaignService.js';
import { reconcilePayment } from './subscriptionController.js';

const STOCKOUT_CRITICAL_DAYS = 3;

let warnedMissingCronSecret = false;

const verifyCronSecret = (req) => {
  if (!process.env.CRON_SECRET) {
    // Every cron hit — including Vercel's own scheduler — will 401 forever
    // until this is set. Distinct from a bad/missing Authorization header so
    // this doesn't read as a generic auth failure in the logs. Logged once
    // per cold start rather than per-request to avoid spamming.
    if (!warnedMissingCronSecret) {
      console.error('[cron] CRON_SECRET is not set on this server — every cron request will be rejected until it is configured.');
      warnedMissingCronSecret = true;
    }
    return false;
  }
  const provided = req.headers.authorization?.replace('Bearer ', '');
  return !!provided && provided === process.env.CRON_SECRET;
};

/**
 * Compares today's running sales total against the shop's trailing
 * HISTORY_DAYS average (z-score) and pushes an anomaly alert to the owner
 * when performance is significantly above or below normal. Runs once daily
 * via Vercel Cron; idempotent per (shop, day) via NotificationLog.
 */
export const dailySalesCheck = async (req, res) => {
  if (!verifyCronSecret(req)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const shops = await Shop.find({ isActive: true });
  const notified = [];
  const failed = [];
  const todayStr = new Date().toISOString().slice(0, 10);

  for (const shop of shops) {
    // One failing shop must not sink the whole batch — record and move on;
    // the next run regenerates it.
    try {
      const anomaly = await detectSalesAnomaly(shop._id);
      if (!anomaly) continue;

      const alreadySent = await NotificationLog.findOne({ shop: shop._id, type: 'daily_sales_anomaly', key: todayStr });
      if (alreadySent) continue;

      const { direction, z, todayTotal, avg, pctDiff } = anomaly;
      const title = direction === 'high' ? '📈 Sales are unusually high today' : '📉 Sales are unusually low today';
      const body = `Today's sales are ${Math.abs(pctDiff)}% ${direction === 'high' ? 'above' : 'below'} your usual average.`;

      const owners = await User.find({ shop: shop._id, role: 'owner' });
      for (const owner of owners) {
        await sendPushToUser(owner, { title, body, data: { type: 'daily_sales_anomaly' } });
      }
      await NotificationLog.create({ shop: shop._id, type: 'daily_sales_anomaly', key: todayStr });
      notified.push({ shop: shop._id, z, todayTotal, avg });
    } catch (err) {
      console.error('[cron] daily sales check failed for shop', String(shop._id), err.message);
      failed.push(String(shop._id));
    }
  }

  res.json({ success: true, processed: shops.length, notified: notified.length, failed, results: notified });
};

/**
 * Pushes a predictive low-stock alert for products projected to run out
 * within STOCKOUT_CRITICAL_DAYS, based on sales velocity (depletionService)
 * rather than the static lowStockAlert threshold. Idempotent per
 * (shop, day) via NotificationLog.
 */
export const depletionAlerts = async (req, res) => {
  if (!verifyCronSecret(req)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const shops = await Shop.find({ isActive: true });
  const notified = [];
  const failed = [];
  const todayStr = new Date().toISOString().slice(0, 10);

  for (const shop of shops) {
    // One failing shop must not sink the whole batch — record and move on;
    // the next run regenerates it.
    try {
      const analytics = await getDepletionAnalytics(shop._id, { windowDays: 30 });
      const critical = analytics.items.filter((i) => i.daysUntilStockout != null && i.daysUntilStockout <= STOCKOUT_CRITICAL_DAYS);
      if (critical.length === 0) continue;

      const alreadySent = await NotificationLog.findOne({ shop: shop._id, type: 'depletion_alert', key: todayStr });
      if (alreadySent) continue;

      const names = critical.slice(0, 3).map((c) => c.name).join(', ');
      const extra = critical.length > 3 ? ` and ${critical.length - 3} more` : '';
      const title = `⚠️ ${critical.length} product${critical.length === 1 ? '' : 's'} running low`;
      const body = `${names}${extra} will run out within ${STOCKOUT_CRITICAL_DAYS} days at current sales pace.`;

      const owners = await User.find({ shop: shop._id, role: 'owner' });
      for (const owner of owners) {
        await sendPushToUser(owner, { title, body, data: { type: 'depletion_alert' } });
      }
      await NotificationLog.create({ shop: shop._id, type: 'depletion_alert', key: todayStr });
      notified.push({ shop: shop._id, count: critical.length });
    } catch (err) {
      console.error('[cron] depletion alerts failed for shop', String(shop._id), err.message);
      failed.push(String(shop._id));
    }
  }

  res.json({ success: true, processed: shops.length, notified: notified.length, failed, results: notified });
};

/**
 * Compiles the end-of-day business summary for every shop with shift
 * management enabled and pushes the headline numbers to owners. Runs once
 * daily via Vercel Cron at business close; idempotent per (shop, day) via
 * NotificationLog, and the summary itself upserts so re-runs only refresh it.
 */
export const dailyBusinessSummary = async (req, res) => {
  if (!verifyCronSecret(req)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const shops = await Shop.find({ isActive: true, shiftManagementEnabled: true });
  const todayStr = new Date().toISOString().slice(0, 10);
  const notified = [];
  const failed = [];

  for (const shop of shops) {
    // One failing shop must not sink the whole batch — record and move on;
    // the next run (or an on-demand GET) regenerates it.
    try {
      const summary = await generateDailySummary(shop._id, todayStr);

      const alreadySent = await NotificationLog.findOne({ shop: shop._id, type: 'daily_summary', key: todayStr });
      if (alreadySent) continue;

      const t = summary.totals;
      const title = `📊 ${shop.name} — today's summary is ready`;
      const parts = [
        `${t.revenue.toFixed(0)} revenue`,
        `${t.transactions} sales`,
        `cash ${summary.byMethod.cash?.total?.toFixed(0) ?? 0} · M-PESA ${summary.byMethod.mpesa?.total?.toFixed(0) ?? 0}`,
      ];
      if (summary.shifts.totalDiscrepancy !== 0) {
        parts.push(`drawer ${summary.shifts.totalDiscrepancy > 0 ? 'over' : 'short'} ${Math.abs(summary.shifts.totalDiscrepancy).toFixed(0)}`);
      }
      const body = parts.join(' · ');

      const owners = await User.find({ shop: shop._id, role: 'owner' });
      for (const owner of owners) {
        await sendPushToUser(owner, { title, body, data: { type: 'daily_summary', date: todayStr } });
      }
      await NotificationLog.create({ shop: shop._id, type: 'daily_summary', key: todayStr });
      notified.push({ shop: shop._id, revenue: t.revenue });
    } catch (err) {
      console.error('[cron] daily summary failed for shop', String(shop._id), err.message);
      failed.push(String(shop._id));
    }
  }

  res.json({ success: true, processed: shops.length, notified: notified.length, failed, results: notified });
};

/**
 * Pushes subscription renewal reminders to shop owners: at each configured
 * window before expiry (default 7 and 3 days), and once when the grace
 * period starts. Idempotent per (reminder kind, expiry date) via the
 * remindersSent list on the subscription, which naturally re-arms after a
 * renewal moves the expiry date.
 */
export const subscriptionReminders = async (req, res) => {
  if (!verifyCronSecret(req)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const platform = await PlatformConfig.get();
  const settings = {
    reminderDaysBefore: platform.reminderDaysBefore,
    gracePeriodDays: platform.gracePeriodDays,
  };

  // Only subscriptions whose expiry is near enough to matter: inside the
  // widest reminder window, or already past expiry but inside grace.
  const maxWindow = Math.max(...platform.reminderDaysBefore, 0);
  const now = new Date();
  const horizon = new Date(now.getTime() + maxWindow * 24 * 60 * 60 * 1000);
  const graceFloor = new Date(now.getTime() - platform.gracePeriodDays * 24 * 60 * 60 * 1000);
  const candidates = await Subscription.find({
    $or: [
      { trialEnd: { $gte: graceFloor, $lte: horizon } },
      { currentPeriodEnd: { $gte: graceFloor, $lte: horizon } },
    ],
  });

  const notified = [];
  const failed = [];

  for (const subscription of candidates) {
    try {
      const due = dueReminder(subscription, settings, now);
      if (!due) continue;

      const { access } = due;
      const what = access.state === 'trialing' || (access.state === 'grace' && !subscription.currentPeriodEnd)
        ? 'free trial'
        : 'subscription';

      let title;
      let body;
      if (due.kind === 'grace') {
        title = '⚠️ Your Smart Duka access is about to pause';
        body = `Your ${what} has ended. Pay within ${access.graceDaysLeft} day${access.graceDaysLeft === 1 ? '' : 's'} to keep selling without interruption.`;
      } else {
        const days = access.daysLeft;
        title = days <= 3 ? `⏳ ${days} day${days === 1 ? '' : 's'} left on your ${what}` : `Your Smart Duka ${what} ends soon`;
        body = `Your ${what} ends in ${days} day${days === 1 ? '' : 's'}. Renew with M-PESA in a minute to keep your shop running.`;
      }

      const owners = await User.find({ shop: subscription.shop, role: 'owner', isActive: true });
      for (const owner of owners) {
        await sendPushToUser(owner, { title, body, data: { type: 'subscription_reminder', kind: due.kind } });
      }

      subscription.remindersSent.push(due.dedupeKey);
      subscription.lastReminderSentAt = now;
      await subscription.save();
      notified.push({ shop: String(subscription.shop), kind: due.kind });
    } catch (err) {
      console.error('[cron] subscription reminder failed for shop', String(subscription.shop), err.message);
      failed.push(String(subscription.shop));
    }
  }

  res.json({ success: true, processed: candidates.length, notified: notified.length, failed, results: notified });
};

/**
 * Sends every admin-scheduled push campaign whose scheduledAt has arrived.
 * Runs every 15 minutes via Vercel Cron. Uses the same atomic claim as the
 * admin "Send now" endpoint (claimAndDispatchCampaign), so a campaign never
 * gets sent twice even if a manual send races this run.
 */
export const pushCampaignDispatch = async (req, res) => {
  if (!verifyCronSecret(req)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const due = await PushCampaign.find({
    status: 'scheduled',
    scheduledAt: { $ne: null, $lte: new Date() },
  }).select('_id');

  const results = [];
  for (const { _id } of due) {
    const campaign = await claimAndDispatchCampaign(_id);
    if (campaign) results.push({ campaign: String(_id), status: campaign.status, stats: campaign.stats });
  }

  res.json({ success: true, processed: due.length, dispatched: results.length, results });
};

/**
 * Safety net for the "paid but never activated" class of bug: re-verifies
 * against Safaricom any subscription payment that hasn't been fully
 * activated yet — whether it's still `pending` (the async callback may
 * simply never arrive), was locally marked `timeout` (we gave up waiting;
 * Safaricom may have still completed it moments later), or was already
 * marked `success` by the callback while the activation step that follows
 * it failed (the callback claims the payment before calling
 * applySuccessfulPayment, so a crash in between leaves `success` with no
 * `periodEnd` — exactly the state this cron exists to catch). Runs every 5
 * minutes via Vercel Cron.
 */
export const subscriptionPaymentReconcile = async (req, res) => {
  if (!verifyCronSecret(req)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const cutoff = new Date(Date.now() - 2 * 60 * 1000);
  const candidates = await SubscriptionPayment.find({
    status: { $in: ['pending', 'timeout', 'success'] },
    createdAt: { $lt: cutoff },
    $or: [{ periodEnd: { $exists: false } }, { periodEnd: null }],
  });

  const results = [];
  for (const payment of candidates) {
    try {
      const { changed } = await reconcilePayment(payment);
      if (changed) results.push({ payment: String(payment._id), status: payment.status });
    } catch (err) {
      console.error('[cron] subscription payment reconcile failed for', String(payment._id), err.message);
    }
  }

  res.json({ success: true, processed: candidates.length, reconciled: results.length, results });
};
