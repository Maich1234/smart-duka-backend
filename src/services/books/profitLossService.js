import Sale from '../../models/Sale.js';
import Expense from '../../models/Expense.js';
import { buildBookDocument, money, periodBounds } from './bookDocument.js';

/**
 * Simplified Profit & Loss: revenue → cost of goods sold → gross profit →
 * operating expenses by category → net profit.
 *
 * Called *Simplified* on purpose, and the footnotes say why. It is not an
 * IFRS statement: there is no depreciation, no accruals, no tax line and no
 * opening/closing stock adjustment, because DuQana does not capture the
 * inputs for any of them. A shopkeeper taking this to a lender should be able
 * to see from the document itself what it does and doesn't cover.
 *
 * COGS comes from the cost snapshotted onto each sale item at the time of
 * sale, not from the product's cost today — otherwise repricing stock would
 * silently rewrite last year's profit. Where a sale predates that snapshot
 * the figure is reconstructed and the whole book is flagged as estimated.
 */

/** A sale counts toward revenue unless it was voided or the money went back. */
const REVENUE_STATUSES = ['completed', 'refund_pending'];

const CATEGORY_LABELS = {
  rent: 'Rent',
  utilities: 'Utilities',
  supplies: 'Supplies',
  transport: 'Transport',
  salaries: 'Salaries & wages',
  marketing: 'Marketing',
  other: 'Other',
};

const COLUMNS = [
  { key: 'line', label: '', align: 'left', type: 'text' },
  { key: 'amount', label: 'Amount', align: 'right', type: 'money' },
];

export async function buildProfitLoss({ shop, ownerName, from, to }) {
  const { start, end } = periodBounds(from, to);
  const shopId = shop._id;

  const [saleAgg, refundAgg, expenses] = await Promise.all([
    Sale.aggregate([
      { $match: { shop: shopId, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: start, $lte: end } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: null,
          revenue: { $sum: '$items.subtotal' },
          discounts: { $sum: { $ifNull: ['$items.discountAmount', 0] } },
          cogs: { $sum: { $ifNull: ['$items.costTotal', 0] } },
          // Any reconstructed cost taints the whole COGS figure, so the book
          // must say so rather than presenting it as measured.
          estimatedLines: { $sum: { $cond: [{ $eq: ['$items.costEstimated', true] }, 1, 0] } },
          missingCost: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$items.costTotal', null] }, null] }, 1, 0] } },
          commission: { $sum: { $ifNull: ['$items.commissionAmount', 0] } },
        },
      },
    ]),
    // Completed refunds reduce revenue in the period the money went back.
    Sale.aggregate([
      { $match: { shop: shopId, status: 'refunded', 'refund.completedAt': { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$refund.amount', '$totalAmount'] } }, count: { $sum: 1 } } },
    ]),
    Expense.aggregate([
      { $match: { shop: shopId, date: { $gte: start, $lte: end } } },
      { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ]),
  ]);

  const s = saleAgg[0] ?? { revenue: 0, discounts: 0, cogs: 0, estimatedLines: 0, missingCost: 0, commission: 0 };
  const refunds = refundAgg[0] ?? { total: 0, count: 0 };

  const grossRevenue = money(s.revenue);
  const refunded = money(refunds.total);
  const netRevenue = money(grossRevenue - refunded);
  const cogs = money(s.cogs);
  const grossProfit = money(netRevenue - cogs);

  const expenseTotal = money(expenses.reduce((sum, e) => sum + e.total, 0));
  const commission = money(s.commission);
  // Commission is a real cost of trading and is not an Expense record, so it
  // would vanish from net profit if it weren't added here explicitly.
  const operatingTotal = money(expenseTotal + commission);
  const netProfit = money(grossProfit - operatingTotal);

  const tradingRows = [
    { line: 'Sales', amount: grossRevenue },
    ...(refunded > 0 ? [{ line: `Less refunds (${refunds.count})`, amount: -refunded }] : []),
    ...(refunded > 0 ? [{ line: 'Net sales', amount: netRevenue }] : []),
    { line: 'Less cost of goods sold', amount: -cogs },
  ];

  const expenseRows = expenses.map((e) => ({
    line: `${CATEGORY_LABELS[e._id] ?? e._id} (${e.count})`,
    amount: -money(e.total),
  }));
  if (commission > 0) expenseRows.push({ line: 'Staff commission', amount: -commission });

  const footnotes = [
    'Simplified Profit & Loss — not an IFRS or audited financial statement.',
    'Excludes depreciation, tax, and any opening/closing stock adjustment, none of which DuQana records.',
    'Cost of goods sold uses the cost captured at the moment of each sale, so later price changes never rewrite past profit.',
  ];
  if (refunded > 0) {
    footnotes.push('Refunds are deducted in the period the money was returned, which may differ from the period of the original sale.');
  }

  const estimated = s.estimatedLines > 0 || s.missingCost > 0;
  if (s.estimatedLines > 0) {
    footnotes.push(`Cost was reconstructed for ${s.estimatedLines} sale line${s.estimatedLines === 1 ? '' : 's'} recorded before per-sale costs were captured, so gross profit is an estimate.`);
  }
  if (s.missingCost > 0) {
    footnotes.push(`${s.missingCost} sale line${s.missingCost === 1 ? ' has' : 's have'} no cost recorded at all and contribute nothing to cost of goods sold — gross profit is overstated by that amount.`);
  }

  return buildBookDocument({
    key: 'profit_loss',
    title: 'Simplified Profit & Loss',
    shop,
    ownerName,
    from,
    to,
    columns: COLUMNS,
    sections: [
      { label: 'Trading', rows: tradingRows, subtotals: { amount: grossProfit } },
      { label: 'Operating expenses', rows: expenseRows, subtotals: { amount: -operatingTotal } },
      { label: 'Result', rows: [{ line: 'Net profit', amount: netProfit }] },
    ],
    totals: {
      revenue: netRevenue,
      costOfGoodsSold: cogs,
      grossProfit,
      operatingExpenses: operatingTotal,
      netProfit,
    },
    footnotes,
    estimated,
  });
}
