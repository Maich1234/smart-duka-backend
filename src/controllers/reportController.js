import Sale from '../models/Sale.js';
import Rating from '../models/Rating.js';
import Expense from '../models/Expense.js';
import { getSalesTrendSeries } from '../services/salesTrendService.js';

export const getSalesReport = async (req, res) => {
  const period = ['daily', 'weekly', 'monthly'].includes(req.query.period) ? req.query.period : 'daily';
  const now = new Date();

  // The trend series is aggregated in the database ($bucket per period, via
  // the shared salesTrendService also used by the chat get_sales_trend
  // tool) — the previous implementation loaded every sale in the whole
  // range (up to 6 months) into memory, which does not scale for a busy shop.
  const { buckets, series } = await getSalesTrendSeries(req.user.shop._id, { period, now });
  const rangeStart = buckets[0].start;

  // Summary/top-products/by-staff/ratings reflect only the *current* bucket
  // (today / this week / this month) — not the whole multi-bucket trend
  // window — so the numbers actually change when switching daily/weekly/
  // monthly instead of staying a rolling sum that looks identical whenever
  // all the shop's history fits inside every window. Full docs are only
  // loaded for the current bucket, whose items[] the top-products and
  // by-staff sections genuinely need.
  const currentBucket = buckets[buckets.length - 1];
  const currentPeriodSales = await Sale.find({
    shop: req.user.shop._id,
    status: { $nin: ['voided', 'refunded'] },
    createdAt: { $gte: currentBucket.start, $lt: currentBucket.end },
  }).select('totalAmount paymentMethod items createdAt staff').populate('staff', 'name');

  const summary = currentPeriodSales.reduce(
    (acc, sale) => ({
      totalRevenue: acc.totalRevenue + sale.totalAmount,
      totalTransactions: acc.totalTransactions + 1,
      cashTotal: acc.cashTotal + (sale.paymentMethod === 'cash' ? sale.totalAmount : 0),
      mpesaTotal: acc.mpesaTotal + (sale.paymentMethod === 'mpesa' ? sale.totalAmount : 0),
    }),
    { totalRevenue: 0, totalTransactions: 0, cashTotal: 0, mpesaTotal: 0 }
  );
  summary.averageSale = summary.totalTransactions > 0
    ? summary.totalRevenue / summary.totalTransactions
    : 0;

  const [expenseAgg] = await Expense.aggregate([
    { $match: { shop: req.user.shop._id, date: { $gte: currentBucket.start, $lt: currentBucket.end } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  summary.expenseTotal = expenseAgg?.total || 0;
  summary.netProfit = summary.totalRevenue - summary.expenseTotal;

  const productTotals = new Map();
  for (const sale of currentPeriodSales) {
    for (const item of sale.items) {
      const existing = productTotals.get(item.productName) || { productName: item.productName, quantitySold: 0, revenue: 0 };
      existing.quantitySold += item.quantity;
      existing.revenue += item.subtotal;
      productTotals.set(item.productName, existing);
    }
  }
  const topProducts = Array.from(productTotals.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  const staffTotals = new Map();
  for (const sale of currentPeriodSales) {
    const staffName = sale.staff?.name || 'Unknown';
    const existing = staffTotals.get(staffName) || { staffName, total: 0, transactionCount: 0, commissionTotal: 0 };
    existing.total += sale.totalAmount;
    existing.transactionCount += 1;
    existing.commissionTotal += sale.items.reduce((sum, item) => sum + (item.commissionAmount || 0), 0);
    staffTotals.set(staffName, existing);
  }
  const byStaff = Array.from(staffTotals.values()).sort((a, b) => b.total - a.total);

  const [ratingAgg] = await Rating.aggregate([
    { $match: { shop: req.user.shop._id, createdAt: { $gte: currentBucket.start, $lt: currentBucket.end } } },
    { $group: { _id: null, avgStars: { $avg: '$stars' }, totalRatings: { $sum: 1 } } },
  ]);
  const ratingSummary = {
    avgStars: ratingAgg?.avgStars || 0,
    totalRatings: ratingAgg?.totalRatings || 0,
  };

  res.json({
    success: true,
    data: { period, rangeStart: rangeStart.toISOString(), summary, series, topProducts, byStaff, ratingSummary },
  });
};
