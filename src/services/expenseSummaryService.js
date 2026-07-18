import Expense from '../models/Expense.js';

/**
 * Total expenses and breakdown by category over an optional date range.
 * Extracted out of expenseController.js so both GET /expenses/summary and
 * the chat get_expense_summary tool aggregate identically.
 */
export const getExpenseSummaryData = async (shopId, { startDate, endDate } = {}) => {
  const query = { shop: shopId };
  if (startDate || endDate) {
    query.date = {};
    if (startDate) query.date.$gte = new Date(startDate);
    if (endDate) query.date.$lte = new Date(endDate);
  }

  // Aggregate in the database — loading every expense document into memory
  // to sum it does not scale past a few thousand records.
  const grouped = await Expense.aggregate([
    { $match: query },
    { $group: { _id: '$category', amount: { $sum: '$amount' } } },
  ]);
  const total = grouped.reduce((sum, g) => sum + g.amount, 0);

  return {
    total,
    byCategory: grouped.map((g) => ({ category: g._id, amount: g.amount })),
  };
};
