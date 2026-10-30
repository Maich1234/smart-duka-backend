import { getPriceHealth } from '../priceHealthService.js';
import Shop from '../../models/Shop.js';
import DailySummary from '../../models/DailySummary.js';
import { generateDailySummary } from '../dailySummaryService.js';
import { calculateHealthScore } from './healthScoreCalculator.js';
import { getDepletionAnalytics } from '../depletionService.js';
import { detectSalesAnomaly } from './salesAnomalyService.js';

// Bump whenever the shape changes — the mobile app's SQLite cache stores
// this alongside each insight and discards rows whose version is stale, so
// a schema change can't otherwise crash the Insights screen against
// pre-update cached data (see utils/aiInsightCache.ts on the mobile app).
// v2: added health.confidence/sufficient/requirements.
const SNAPSHOT_VERSION = 3;
const TREND_WINDOW_DAYS = 30;

const todayStr = () => new Date().toISOString().slice(0, 10);

const sumRange = (summariesMostRecentFirst, days) => {
  const slice = summariesMostRecentFirst.slice(0, days);
  return {
    revenue: slice.reduce((sum, d) => sum + d.totals.revenue, 0),
    profit: slice.reduce((sum, d) => sum + d.totals.grossProfit, 0),
    expenses: slice.reduce((sum, d) => sum + d.totals.expenses, 0),
  };
};

/**
 * Assembles the single, versioned object every AI-facing consumer reads —
 * the dashboard, the Insights screen, and the Gemini gateway all depend on
 * this shape, not on raw collections. Values are numeric only; formatting
 * (currency strings, relative dates, etc.) is a client concern — see
 * utils/formatters.ts on the mobile app.
 */
export const buildBusinessSnapshot = async (shopId) => {
  const today = todayStr();

  const [shop, todaySummary, trailingSummaries] = await Promise.all([
    Shop.findById(shopId).select('name address country currency').lean(),
    generateDailySummary(shopId, today),
    DailySummary.find({ shop: shopId, date: { $lt: today } })
      .sort({ date: -1 })
      .limit(TREND_WINDOW_DAYS)
      .lean(),
  ]);

  const recentSummaries = [todaySummary, ...trailingSummaries];
  const health = calculateHealthScore(recentSummaries);

  const [depletion, anomaly, priceHealth] = await Promise.all([
    getDepletionAnalytics(shopId, { windowDays: 30 }),
    detectSalesAnomaly(shopId),
    getPriceHealth(shopId, { limit: 10 }),
  ]);

  const alerts = [];
  if (priceHealth.summary.affectedPriceRows || priceHealth.realised.belowCostSaleLines) alerts.push({ type: 'price_health', severity: 'critical', message: `${priceHealth.summary.affectedPriceRows} product/variant prices need review. Potential gross shortfall at current prices: ${priceHealth.summary.potentialLoss}. Recorded below-cost sales shortfall over the last 30 days: ${priceHealth.realised.recordedLoss}. Missing costs are excluded; bundle stock is not counted twice.` });
  if (anomaly) {
    alerts.push({
      type: 'sales_anomaly',
      severity: anomaly.direction === 'low' ? 'warning' : 'info',
      message: `Sales are ${Math.abs(anomaly.pctDiff)}% ${anomaly.direction === 'high' ? 'above' : 'below'} your usual average today.`,
    });
  }
  for (const item of depletion.stockoutSoon.slice(0, 5)) {
    alerts.push({
      type: 'stockout_risk',
      severity: item.daysUntilStockout <= 3 ? 'critical' : 'warning',
      message: `${item.name} projected to run out in ${Math.ceil(item.daysUntilStockout)} day(s).`,
    });
  }

  return {
    version: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    business: {
      name: shop?.name ?? null,
      address: shop?.address ?? null,
      country: shop?.country ?? null,
      currency: shop?.currency ?? 'KES',
    },
    today: {
      revenue: todaySummary.totals.revenue,
      profit: todaySummary.totals.grossProfit,
      expenses: todaySummary.totals.expenses,
      transactions: todaySummary.totals.transactions,
      topProduct: todaySummary.bestSellers[0] ?? null,
    },
    trend: {
      week: sumRange(recentSummaries, 7),
      month: sumRange(recentSummaries, 30),
    },
    priceHealth,
    inventory: {
      stockValue: todaySummary.inventory.stockValue,
      lowStockCount: todaySummary.inventory.lowStockCount,
      fastMovers: depletion.fastMovers.slice(0, 5).map((p) => p.name),
      slowMovers: depletion.slowMovers.slice(0, 5).map((p) => p.name),
    },
    payments: todaySummary.byMethod,
    staff: todaySummary.staffPerformance,
    health,
    alerts,
    insights: [...(priceHealth.summary.affectedPriceRows ? [`Review ${priceHealth.summary.affectedPriceRows} product/variant pricing alerts before the next sale.`] : []), ...todaySummary.insights],
  };
};
