import Sale from '../../models/Sale.js';

const Z_THRESHOLD = 1.5;
const HISTORY_DAYS = 14;

const mean = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);
const stdDev = (arr, avg) => Math.sqrt(arr.reduce((a, b) => a + (b - avg) ** 2, 0) / (arr.length || 1));

/**
 * Compares a shop's running sales total for today against its trailing
 * HISTORY_DAYS average (z-score). Shared by the daily-sales-check cron
 * (push notifications) and the BusinessSnapshot builder (AI alerts) so the
 * anomaly definition never drifts between the two. Returns null when there
 * isn't enough history yet, or when today isn't a statistical outlier.
 */
export const detectSalesAnomaly = async (shopId) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const historyStart = new Date(startOfToday.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);

  const sales = await Sale.find({
    shop: shopId,
    status: { $nin: ['voided', 'refunded'] },
    createdAt: { $gte: historyStart },
  }).select('totalAmount createdAt');

  const dailyTotals = new Map();
  for (const s of sales) {
    const day = s.createdAt.toISOString().slice(0, 10);
    dailyTotals.set(day, (dailyTotals.get(day) || 0) + s.totalAmount);
  }

  const todayStr = startOfToday.toISOString().slice(0, 10);
  const todayTotal = dailyTotals.get(todayStr) || 0;
  const historicalTotals = [...dailyTotals.entries()].filter(([day]) => day !== todayStr).map(([, total]) => total);
  if (historicalTotals.length < 3) return null;

  const avg = mean(historicalTotals);
  const sd = stdDev(historicalTotals, avg);
  if (sd === 0) return null;

  const z = (todayTotal - avg) / sd;
  if (Math.abs(z) < Z_THRESHOLD) return null;

  const pctDiff = avg > 0 ? Math.round(((todayTotal - avg) / avg) * 100) : 0;
  return { direction: z > 0 ? 'high' : 'low', z, todayTotal, avg, pctDiff };
};
