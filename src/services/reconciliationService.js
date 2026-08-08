import mongoose from 'mongoose';
import Shift from '../models/Shift.js';
import Sale from '../models/Sale.js';
import Expense from '../models/Expense.js';
import Purchase from '../models/Purchase.js';
import User from '../models/User.js';

const round2 = (n) => Math.round((n || 0) * 100) / 100;

/**
 * Per-cashier reconciliation for a date range: rolls up the frozen
 * `Shift.summary` snapshots written at shift-close (see shiftService.js)
 * rather than recomputing cash math from raw Sales — this guarantees the
 * totals here never drift from the per-shift reconciliation UI owners
 * already trust. Bucketed on `endedAt`, matching dailySummaryService's
 * shift-rollup convention, so a day/week/month total reconciles exactly
 * against the corresponding DailySummary docs for the same range.
 *
 * Shifts still open at `end` are excluded from the money totals (their
 * summary isn't written yet) but counted separately as `unclosedCount` so an
 * owner sees "this drawer isn't reconciled yet" instead of it silently
 * vanishing from the report.
 */
export const getCashierReconciliation = async ({ shopId, start, end, staffId }) => {
  const shop = new mongoose.Types.ObjectId(String(shopId));
  const closedMatch = { shop, status: 'closed', endedAt: { $gte: start, $lt: end } };
  const activeMatch = { shop, status: 'active', startedAt: { $lt: end } };
  if (staffId) {
    closedMatch.staff = new mongoose.Types.ObjectId(String(staffId));
    activeMatch.staff = new mongoose.Types.ObjectId(String(staffId));
  }

  const [rollup, unclosedAgg] = await Promise.all([
    Shift.aggregate([
      { $match: closedMatch },
      {
        $group: {
          _id: '$staff',
          shiftsCount: { $sum: 1 },
          salesCount: { $sum: '$summary.salesCount' },
          grossSales: { $sum: '$summary.grossSales' },
          discounts: { $sum: '$summary.discounts' },
          cashSales: { $sum: '$summary.byMethod.cash.total' },
          mpesaSales: { $sum: '$summary.byMethod.mpesa.total' },
          cardSales: { $sum: '$summary.byMethod.card.total' },
          refundsCount: { $sum: '$summary.refunds.count' },
          refundsTotal: { $sum: '$summary.refunds.total' },
          voidsCount: { $sum: '$summary.voids.count' },
          voidsTotal: { $sum: '$summary.voids.total' },
          cashExpensesTotal: { $sum: '$summary.cashExpenses.total' },
          openingFloatTotal: { $sum: '$openingFloat' },
          expectedCashTotal: { $sum: '$summary.expectedCash' },
          actualCashTotal: { $sum: '$closingCount' },
          cashDiscrepancyTotal: { $sum: '$summary.cashDiscrepancy' },
        },
      },
      { $sort: { grossSales: -1 } },
    ]),
    Shift.aggregate([
      { $match: activeMatch },
      { $group: { _id: '$staff', unclosedCount: { $sum: 1 } } },
    ]),
  ]);

  const unclosedByStaff = new Map(unclosedAgg.map((u) => [String(u._id), u.unclosedCount]));

  const cashiers = rollup.map((r) => ({
    staffId: r._id,
    shiftsCount: r.shiftsCount,
    unclosedCount: unclosedByStaff.get(String(r._id)) ?? 0,
    salesCount: r.salesCount,
    grossSales: round2(r.grossSales),
    discounts: round2(r.discounts),
    byMethod: {
      cash: round2(r.cashSales),
      mpesa: round2(r.mpesaSales),
      card: round2(r.cardSales),
    },
    refunds: { count: r.refundsCount, total: round2(r.refundsTotal) },
    voids: { count: r.voidsCount, total: round2(r.voidsTotal) },
    cashExpensesTotal: round2(r.cashExpensesTotal),
    openingFloatTotal: round2(r.openingFloatTotal),
    expectedCashTotal: round2(r.expectedCashTotal),
    actualCashTotal: round2(r.actualCashTotal),
    cashDiscrepancyTotal: round2(r.cashDiscrepancyTotal),
  }));

  // A staff member with only an unclosed shift in range (no closed ones yet)
  // wouldn't otherwise appear — surface them with zeroed money totals so
  // "drawer still open" is visible rather than the person vanishing entirely.
  const missingIds = [...unclosedByStaff.keys()].filter(
    (id) => !cashiers.some((c) => String(c.staffId) === id)
  );
  for (const id of missingIds) {
    cashiers.push({
      staffId: new mongoose.Types.ObjectId(id),
      shiftsCount: 0,
      unclosedCount: unclosedByStaff.get(id),
      salesCount: 0,
      grossSales: 0,
      discounts: 0,
      byMethod: { cash: 0, mpesa: 0, card: 0 },
      refunds: { count: 0, total: 0 },
      voids: { count: 0, total: 0 },
      cashExpensesTotal: 0,
      openingFloatTotal: 0,
      expectedCashTotal: 0,
      actualCashTotal: 0,
      cashDiscrepancyTotal: 0,
    });
  }

  const staffUsers = await User.find({ _id: { $in: cashiers.map((c) => c.staffId) } }).select('name').lean();
  const nameById = new Map(staffUsers.map((u) => [String(u._id), u.name]));
  for (const c of cashiers) {
    c.staffName = nameById.get(String(c.staffId)) ?? 'Unknown';
  }
  cashiers.sort((a, b) => b.grossSales - a.grossSales);

  return { cashiers };
};

/**
 * Shop-wide sales vs. expenses vs. purchases for a date range — a P&L view,
 * not a cash-only one: purchases include credit-paid stock (no cash moved)
 * on purpose, since the goal is reconciling accrual spend against revenue,
 * mirroring how reportController's netProfit already treats Expenses.
 */
export const getMonthlyFinancialReconciliation = async ({ shopId, start, end }) => {
  const shop = new mongoose.Types.ObjectId(String(shopId));

  const [revenueAgg, expenseAgg, expenseByCategoryAgg, purchaseAgg] = await Promise.all([
    Sale.aggregate([
      { $match: { shop, status: { $nin: ['voided', 'refunded'] }, createdAt: { $gte: start, $lt: end } } },
      { $group: { _id: null, total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
    ]),
    Expense.aggregate([
      { $match: { shop, date: { $gte: start, $lt: end } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Expense.aggregate([
      { $match: { shop, date: { $gte: start, $lt: end } } },
      { $group: { _id: '$category', total: { $sum: '$amount' } } },
      { $sort: { total: -1 } },
    ]),
    // createdAt, not purchaseDate — matches purchaseSummaryService's existing
    // convention so this reconciles against the Purchasing module's own totals.
    Purchase.aggregate([
      { $match: { shop, status: 'completed', createdAt: { $gte: start, $lt: end } } },
      { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
    ]),
  ]);

  const revenue = round2(revenueAgg[0]?.total);
  const expenses = round2(expenseAgg[0]?.total);
  const purchases = round2(purchaseAgg[0]?.total);

  return {
    revenue,
    salesCount: revenueAgg[0]?.count ?? 0,
    expenses,
    expensesByCategory: expenseByCategoryAgg.map((c) => ({ category: c._id, total: round2(c.total) })),
    purchases,
    purchaseCount: purchaseAgg[0]?.count ?? 0,
    netCashPosition: round2(revenue - expenses - purchases),
  };
};
