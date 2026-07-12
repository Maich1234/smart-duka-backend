const REVENUE_DROP_THRESHOLD = 0.2; // 20% below trailing average
const REVENUE_JUMP_THRESHOLD = 0.2; // 20% above trailing average
const EXPENSE_SPIKE_MULTIPLIER = 1.5; // 50% above trailing average
const MIN_TRAILING_DAYS = 3;

const average = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0);

/**
 * Rule-based, deterministic takeaways for a day's business summary — no AI.
 * `trailingSummaries` (most-recent-first, excluding today) lets the revenue
 * and expense checks compare against the shop's own recent history instead
 * of a fixed threshold.
 */
export const generateDailyInsights = (today, trailingSummaries = []) => {
  const { totals, refunds, voids, shifts, inventory, bestSellers, mpesaReconciliation } = today;
  const insights = [];

  if (totals.revenue === 0) {
    insights.push('No sales were recorded today.');
    return insights;
  }

  if (bestSellers[0]) {
    insights.push(`${bestSellers[0].name} led the day with ${bestSellers[0].quantity} sold.`);
  }

  if (totals.grossProfit > 0) {
    const margin = Math.round((totals.grossProfit / totals.revenue) * 100);
    insights.push(`Estimated gross margin: ${margin}% of revenue.`);
  }

  const trailingRevenues = trailingSummaries.map((s) => s.totals.revenue).filter((r) => r > 0);
  if (trailingRevenues.length >= MIN_TRAILING_DAYS) {
    const avgRevenue = average(trailingRevenues);
    if (avgRevenue > 0) {
      const pctDiff = (totals.revenue - avgRevenue) / avgRevenue;
      if (pctDiff <= -REVENUE_DROP_THRESHOLD) {
        insights.push(`Revenue is ${Math.round(Math.abs(pctDiff) * 100)}% below your recent ${trailingRevenues.length}-day average.`);
      } else if (pctDiff >= REVENUE_JUMP_THRESHOLD) {
        insights.push(`Revenue is ${Math.round(pctDiff * 100)}% above your recent ${trailingRevenues.length}-day average.`);
      }
    }
  }

  const trailingExpenses = trailingSummaries.map((s) => s.totals.expenses).filter((e) => e > 0);
  if (trailingExpenses.length >= MIN_TRAILING_DAYS) {
    const avgExpenses = average(trailingExpenses);
    if (avgExpenses > 0 && totals.expenses > avgExpenses * EXPENSE_SPIKE_MULTIPLIER) {
      insights.push("Today's expenses are significantly above your recent average.");
    }
  }

  if (shifts.totalDiscrepancy < 0) {
    insights.push(`Cash drawers were short by ${Math.abs(shifts.totalDiscrepancy).toFixed(0)} across today's shifts — worth a look.`);
  } else if (shifts.count > 0 && shifts.totalDiscrepancy === 0) {
    insights.push('Every drawer balanced to the shilling today.');
  }
  if (shifts.unclosed > 0) {
    insights.push(`${shifts.unclosed} shift${shifts.unclosed === 1 ? ' is' : 's are'} still open — remind staff to clock out.`);
  }

  const refundRate = totals.transactions > 0 ? refunds.count / totals.transactions : 0;
  if (refundRate > 0.05) {
    insights.push(`Refunds hit ${Math.round(refundRate * 100)}% of transactions today — above the healthy range.`);
  }
  if (voids.count > 2) {
    insights.push(`${voids.count} sales were voided today; frequent voids can signal training gaps or misuse.`);
  }
  if (inventory.lowStockCount > 0) {
    insights.push(`${inventory.lowStockCount} product${inventory.lowStockCount === 1 ? ' is' : 's are'} at or below their low-stock alert.`);
  }
  if (Math.abs(mpesaReconciliation.delta) > 1) {
    insights.push(`M-PESA records differ from recorded sales by ${Math.abs(mpesaReconciliation.delta).toFixed(0)} — reconcile before banking.`);
  }

  return insights;
};
