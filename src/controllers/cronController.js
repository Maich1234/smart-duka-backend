import Shop from '../models/Shop.js';
import Sale from '../models/Sale.js';
import User from '../models/User.js';
import NotificationLog from '../models/NotificationLog.js';
import { sendPushToUser } from '../utils/push.js';
import { getDepletionAnalytics } from '../services/depletionService.js';

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

    const sales = await Sale.find({ shop: shop._id, createdAt: { $gte: historyStart } }).select('totalAmount createdAt');

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
