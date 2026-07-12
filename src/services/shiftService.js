import Sale from '../models/Sale.js';
import Expense from '../models/Expense.js';
import AuditLog from '../models/AuditLog.js';
import Shift from '../models/Shift.js';

/** The staff member's current open shift, or null. */
export const getActiveShift = (staffId) =>
  Shift.findOne({ staff: staffId, status: 'active' });

/**
 * Pure reconciliation math — separated from data fetching so the money logic
 * is unit-testable without a database.
 *
 * @param {Object} input
 * @param {number} input.openingFloat
 * @param {number} [input.closingCount] - cash physically counted at close
 * @param {Array<{totalAmount:number, paymentMethod:string, status:string,
 *   items?:Array<{discountAmount?:number}>,
 *   refund?:{amount?:number, method?:string}}>} input.sales - every sale linked to the shift
 * @param {Array<{amount:number}>} input.cashExpenses - cash expenses recorded during the shift
 * @param {number} input.stockAdjustments - count of manual stock adjustments
 * @param {Date} input.startedAt
 * @param {Date} input.endedAt
 */
export const computeShiftSummary = ({
  openingFloat = 0,
  closingCount,
  sales = [],
  cashExpenses = [],
  stockAdjustments = 0,
  startedAt,
  endedAt,
}) => {
  const byMethod = {
    cash: { count: 0, total: 0 },
    mpesa: { count: 0, total: 0 },
    card: { count: 0, total: 0 },
  };
  const refunds = { count: 0, total: 0, cashTotal: 0 };
  const voids = { count: 0, total: 0 };
  let grossSales = 0;
  let discounts = 0;
  let salesCount = 0;

  for (const sale of sales) {
    if (sale.status === 'voided') {
      voids.count += 1;
      voids.total += sale.totalAmount;
      continue;
    }

    // Refunded sales took payment first, so they still count toward what the
    // drawer/telco received — the refund is then subtracted separately.
    salesCount += 1;
    grossSales += sale.totalAmount;
    for (const item of sale.items ?? []) {
      discounts += item.discountAmount || 0;
    }
    const method = byMethod[sale.paymentMethod];
    if (method) {
      method.count += 1;
      method.total += sale.totalAmount;
    }

    if (sale.status === 'refunded') {
      const amount = sale.refund?.amount ?? sale.totalAmount;
      refunds.count += 1;
      refunds.total += amount;
      if (sale.refund?.method === 'cash') refunds.cashTotal += amount;
    }
  }

  const cashExpensesTotal = cashExpenses.reduce((sum, e) => sum + (e.amount || 0), 0);
  const expectedCash =
    openingFloat + byMethod.cash.total - refunds.cashTotal - cashExpensesTotal;
  const cashDiscrepancy =
    closingCount === undefined || closingCount === null
      ? null
      : Math.round((closingCount - expectedCash) * 100) / 100;

  const durationMinutes =
    startedAt && endedAt
      ? Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 60000))
      : undefined;

  return {
    salesCount,
    grossSales,
    discounts,
    byMethod,
    refunds,
    voids,
    cashExpenses: { count: cashExpenses.length, total: cashExpensesTotal },
    stockAdjustments,
    expectedCash: Math.round(expectedCash * 100) / 100,
    cashDiscrepancy,
    durationMinutes,
  };
};

/** Fetches everything linked to a shift and runs the reconciliation. */
export const buildShiftSummary = async (shift, { closingCount, endedAt } = {}) => {
  const [sales, cashExpenses, stockAdjustments] = await Promise.all([
    Sale.find({ shift: shift._id }).select('totalAmount paymentMethod status items.discountAmount refund.amount refund.method').lean(),
    Expense.find({ shift: shift._id }).select('amount').lean(),
    AuditLog.countDocuments({ shopId: shift.shop, action: 'inventory.stock_adjusted', 'details.shiftId': String(shift._id) }),
  ]);

  return computeShiftSummary({
    openingFloat: shift.openingFloat,
    closingCount,
    sales,
    cashExpenses,
    stockAdjustments,
    startedAt: shift.startedAt,
    endedAt: endedAt ?? new Date(),
  });
};
