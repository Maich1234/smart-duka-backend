import Shop from '../models/Shop.js';
import Sale from '../models/Sale.js';
import User from '../models/User.js';
import NotificationLog from '../models/NotificationLog.js';
import Subscription from '../models/Subscription.js';
import PlatformConfig from '../models/PlatformConfig.js';
import { sendPushToUser } from '../utils/push.js';
import { getDepletionAnalytics } from '../services/depletionService.js';
import { generateDailySummary } from '../services/dailySummaryService.js';
import { dueReminder } from '../services/subscriptionPricingService.js';

const Z_THRESHOLD = 1.5;
const HISTORY_DAYS = 14;
const STOCKOUT_CRITICAL_DAYS = 3;

const verifyCronSecret = (req) => {
  const provided = req.headers.authorization?.replace('Bearer ', '');
  return !!provided && provided === process.env.CRON_SECRET;
};

const mean = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
const stdDev = (arr, avg) => Math.sqrt(arr.reduce((a, b) => a + (b - avg) ** 2, 0) / (arr.length || 1));

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

  for (const shop of shops) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const historyStart = new Date(startOfToday.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);

    const sales = await Sale.find({ shop: shop._id, status: { $nin: ['voided', 'refunded'] }, createdAt: { $gte: historyStart } }).select('totalAmount createdAt');

    const dailyTotals = new Map();
    for (const s of sales) {
      const day = s.createdAt.toISOString().slice(0, 10);
      dailyTotals.set(day, (dailyTotals.get(day) || 0) + s.totalAmount);
    }

    const todayStr = startOfToday.toISOString().slice(0, 10);
    const todayTotal = dailyTotals.get(todayStr) || 0;
    const historicalTotals = [...dailyTotals.entries()].filter(([day]) => day !== todayStr).map(([, total]) => total);
    if (historicalTotals.length < 3) continue; // not enough history to judge yet

    const avg = mean(historicalTotals);
    const sd = stdDev(historicalTotals, avg);
    if (sd === 0) continue;

    const z = (todayTotal - avg) / sd;
    if (Math.abs(z) < Z_THRESHOLD) continue;

    const alreadySent = await NotificationLog.findOne({ shop: shop._id, type: 'daily_sales_anomaly', key: todayStr });
    if (alreadySent) continue;

    const pctDiff = avg > 0 ? Math.round(((todayTotal - avg) / avg) * 100) : 0;
    const title = z > 0 ? '📈 Sales are unusually high today' : '📉 Sales are unusually low today';
    const body = `Today's sales are ${Math.abs(pctDiff)}% ${z > 0 ? 'above' : 'below'} your usual average.`;

    const owners = await User.find({ shop: shop._id, role: 'owner' });
    for (const owner of owners) {
      await sendPushToUser(owner, { title, body, data: { type: 'daily_sales_anomaly' } });
    }
    await NotificationLog.create({ shop: shop._id, type: 'daily_sales_anomaly', key: todayStr });
    notified.push({ shop: shop._id, z, todayTotal, avg });
  }

  res.json({ success: true, processed: shops.length, notified: notified.length, results: notified });
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
  const todayStr = new Date().toISOString().slice(0, 10);

  for (const shop of shops) {
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
  }

  res.json({ success: true, processed: shops.length, notified: notified.length, results: notified });
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
