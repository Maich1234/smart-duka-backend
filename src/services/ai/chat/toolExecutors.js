import { buildBusinessSnapshot } from '../../intelligence/businessSnapshotBuilder.js';
import { generateDailySummary } from '../../dailySummaryService.js';
import { getSalesTrendSeries } from '../../salesTrendService.js';
import { getPeakHoursAnalytics } from '../../intelligence/peakHoursService.js';
import { getDepletionAnalytics } from '../../depletionService.js';
import { detectSalesAnomaly } from '../../intelligence/salesAnomalyService.js';
import { getStaffPerformance } from '../../intelligence/staffPerformanceService.js';
import { getExpenseSummaryData } from '../../expenseSummaryService.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayStr = () => new Date().toISOString().slice(0, 10);
const validDate = (value) => (DATE_RE.test(value) ? value : undefined);
const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * name -> executor map. Every executor's signature is `(shopId, args) =>
 * Promise<result>` with `shopId` always the orchestrator-injected first
 * argument — args (Gemini's tool-call arguments) never carry tenant
 * scoping, since no FunctionDeclaration.parameters schema exposes a
 * shop/shopId field to begin with (see toolRegistry.js). Numeric/date args
 * are still clamped/validated here as defense in depth against a
 * misbehaving model passing e.g. windowDays: 99999999.
 */
export const toolExecutors = {
  get_business_snapshot: (shopId) => buildBusinessSnapshot(shopId),

  get_daily_summary: (shopId, args) => generateDailySummary(shopId, validDate(args?.date) ?? todayStr()),

  get_sales_trend: async (shopId, args) => {
    const period = ['daily', 'weekly', 'monthly'].includes(args?.period) ? args.period : 'daily';
    const { series, rangeStart } = await getSalesTrendSeries(shopId, { period });
    return { period, rangeStart, series };
  },

  get_peak_hours: (shopId, args) =>
    getPeakHoursAnalytics(shopId, { windowDays: clamp(args?.windowDays, 1, 90, 30) }),

  get_depletion_analytics: (shopId, args) =>
    getDepletionAnalytics(shopId, { windowDays: clamp(args?.windowDays, 1, 90, 30) }),

  detect_sales_anomaly: async (shopId) =>
    (await detectSalesAnomaly(shopId)) ?? { message: 'No statistically significant anomaly today.' },

  get_staff_performance: (shopId, args) =>
    getStaffPerformance(shopId, { startDate: validDate(args?.startDate), endDate: validDate(args?.endDate) }),

  get_expense_summary: (shopId, args) =>
    getExpenseSummaryData(shopId, { startDate: validDate(args?.startDate), endDate: validDate(args?.endDate) }),
};
