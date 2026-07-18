/**
 * Deterministic 0-100 business health score computed from the shop's recent
 * DailySummary history — no AI, no storage; cheap enough to recompute on
 * every read. Weights are named constants here so they're tunable without
 * touching the scoring logic itself.
 */
export const HEALTH_WEIGHTS = {
  revenue: 0.25,
  profit: 0.25,
  inventory: 0.2,
  cashFlow: 0.2,
  staff: 0.1,
};

// Below these, the component scorers fall back to "neutral" defaults
// (see scoreRevenueTrend etc.) that aren't backed by real history — a
// brand-new shop would otherwise read as a healthy ~65-70/100 on day one.
// sufficient=false tells clients to hide the score and show a confidence
// checklist instead, so those defaults never reach an owner as a verdict.
export const MIN_DATA_REQUIREMENTS = {
  salesDays: 7,
  transactions: 50,
};

const average = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0);
const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, n));

/** Compares the more-recent half of the window against the older half. */
const scoreRevenueTrend = (summaries) => {
  const revenues = summaries.map((s) => s.totals.revenue);
  if (revenues.length < 2) return 70;
  const midpoint = Math.ceil(revenues.length / 2);
  const recent = average(revenues.slice(0, midpoint));
  const older = average(revenues.slice(midpoint));
  if (older === 0) return recent > 0 ? 80 : 50;
  const growth = (recent - older) / older;
  return clamp(60 + growth * 100);
};

const scoreProfitMargin = (summaries) => {
  const margins = summaries
    .filter((s) => s.totals.revenue > 0)
    .map((s) => s.totals.grossProfit / s.totals.revenue);
  if (margins.length === 0) return 50;
  return clamp(average(margins) * 200); // a 50% average margin scores 100
};

const scoreInventory = (summaries) => {
  const latest = summaries[0];
  if (!latest) return 70;
  const lowStockPenalty = Math.min(latest.inventory.lowStockCount * 5, 40);
  return clamp(100 - lowStockPenalty);
};

const scoreCashFlow = (summaries) => {
  if (summaries.length === 0) return 70;
  const avgDiscrepancy = average(summaries.map((s) => Math.abs(s.shifts?.totalDiscrepancy ?? 0)));
  const avgRefundVoidRate = average(
    summaries.map((s) => {
      const txns = s.totals.transactions || 1;
      return (s.refunds.count + s.voids.count) / txns;
    })
  );
  const discrepancyScore = clamp(100 - avgDiscrepancy);
  const rateScore = clamp(100 - avgRefundVoidRate * 500);
  return clamp((discrepancyScore + rateScore) / 2);
};

const scoreStaff = (summaries) => {
  const latest = summaries[0];
  if (!latest?.staffPerformance?.length) return 70;
  return 80;
};

/**
 * How much real evidence backs the score above — independent of the score
 * itself, since a thin history scores a bland ~65-70 rather than a visibly
 * wrong number. `sufficient` gates whether clients should show the score at
 * all; `confidence` and `requirements` drive the "not enough data yet"
 * checklist while it's false.
 */
const calculateDataSufficiency = (summaries) => {
  const daysWithSales = summaries.filter((s) => s.totals.revenue > 0).length;
  const totalTransactions = summaries.reduce((sum, s) => sum + s.totals.transactions, 0);
  const hasExpenses = summaries.some((s) => s.totals.expenses > 0);
  const hasInventoryActivity = (summaries[0]?.inventory.stockValue ?? 0) > 0;

  const requirements = [
    {
      key: 'salesDays',
      label: 'Days of sales recorded',
      met: daysWithSales >= MIN_DATA_REQUIREMENTS.salesDays,
      current: daysWithSales,
      target: MIN_DATA_REQUIREMENTS.salesDays,
    },
    {
      key: 'transactions',
      label: 'Completed transactions',
      met: totalTransactions >= MIN_DATA_REQUIREMENTS.transactions,
      current: totalTransactions,
      target: MIN_DATA_REQUIREMENTS.transactions,
    },
    { key: 'expenses', label: 'Expenses recorded', met: hasExpenses },
    { key: 'inventory', label: 'Inventory activity', met: hasInventoryActivity },
  ];

  const progress = requirements.reduce((sum, r) => {
    if (r.target == null) return sum + (r.met ? 1 : 0);
    return sum + Math.min(r.current / r.target, 1);
  }, 0);

  return {
    confidence: Math.round((progress / requirements.length) * 100),
    sufficient: requirements.every((r) => r.met),
    requirements,
  };
};

/**
 * `recentSummaries` may be in any order — sorted internally, most-recent
 * first, so scorers can treat index 0 as "today"/"latest".
 */
export const calculateHealthScore = (recentSummaries) => {
  const summaries = [...recentSummaries].sort((a, b) => (a.date < b.date ? 1 : -1));

  const components = {
    revenue: Math.round(scoreRevenueTrend(summaries)),
    profit: Math.round(scoreProfitMargin(summaries)),
    inventory: Math.round(scoreInventory(summaries)),
    cashFlow: Math.round(scoreCashFlow(summaries)),
    staff: Math.round(scoreStaff(summaries)),
  };

  const score = Math.round(
    Object.entries(HEALTH_WEIGHTS).reduce((sum, [key, weight]) => sum + components[key] * weight, 0)
  );

  const { confidence, sufficient, requirements } = calculateDataSufficiency(summaries);

  return { score: clamp(score), components, confidence, sufficient, requirements };
};
