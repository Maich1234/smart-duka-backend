import Sale from '../models/Sale.js';
import Rating from '../models/Rating.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  return d;
}

function startOfMonth(date) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/**
 * Builds the bucket boundaries for a period, oldest first. Buckets with no
 * sales still appear (zero-filled) so owners can see gaps, not just totals.
 */
function buildBuckets(period, now) {
  if (period === 'weekly') {
    const buckets = [];
    const currentWeekStart = startOfWeek(now);
    for (let i = 7; i >= 0; i--) {
      const start = new Date(currentWeekStart.getTime() - i * 7 * DAY_MS);
      const end = new Date(start.getTime() + 7 * DAY_MS);
      buckets.push({ start, end, label: `Wk of ${start.toISOString().slice(0, 10)}` });
    }
    return buckets;
  }

  if (period === 'monthly') {
    const buckets = [];
    const base = startOfMonth(now);
    for (let i = 5; i >= 0; i--) {
      const start = new Date(base.getFullYear(), base.getMonth() - i, 1);
      const end = new Date(base.getFullYear(), base.getMonth() - i + 1, 1);
      buckets.push({
        start,
        end,
        label: start.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      });
    }
    return buckets;
  }

  // daily — last 7 days
  const buckets = [];
  const today = startOfDay(now);
  for (let i = 6; i >= 0; i--) {
    const start = new Date(today.getTime() - i * DAY_MS);
    const end = new Date(start.getTime() + DAY_MS);
    buckets.push({
      start,
      end,
      label: start.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' }),
    });
  }
  return buckets;
}

export const getSalesReport = async (req, res) => {
  const period = ['daily', 'weekly', 'monthly'].includes(req.query.period) ? req.query.period : 'daily';
  const now = new Date();
  const buckets = buildBuckets(period, now);
  const rangeStart = buckets[0].start;

  const sales = await Sale.find({
    shop: req.user.shop._id,
    createdAt: { $gte: rangeStart },
  }).select('totalAmount paymentMethod items createdAt staff').populate('staff', 'name');

  const series = buckets.map((bucket) => {
    const bucketSales = sales.filter(
      (sale) => sale.createdAt >= bucket.start && sale.createdAt < bucket.end
    );
    const total = bucketSales.reduce((sum, sale) => sum + sale.totalAmount, 0);
    const cashTotal = bucketSales
      .filter((sale) => sale.paymentMethod === 'cash')
      .reduce((sum, sale) => sum + sale.totalAmount, 0);
    const mpesaTotal = bucketSales
      .filter((sale) => sale.paymentMethod === 'mpesa')
      .reduce((sum, sale) => sum + sale.totalAmount, 0);

    return {
      label: bucket.label,
      date: bucket.start.toISOString(),
      total,
      cashTotal,
      mpesaTotal,
      transactionCount: bucketSales.length,
    };
  });

  const summary = series.reduce(
    (acc, bucket) => ({
      totalRevenue: acc.totalRevenue + bucket.total,
      totalTransactions: acc.totalTransactions + bucket.transactionCount,
      cashTotal: acc.cashTotal + bucket.cashTotal,
      mpesaTotal: acc.mpesaTotal + bucket.mpesaTotal,
    }),
    { totalRevenue: 0, totalTransactions: 0, cashTotal: 0, mpesaTotal: 0 }
  );
  summary.averageSale = summary.totalTransactions > 0
    ? summary.totalRevenue / summary.totalTransactions
    : 0;

  const productTotals = new Map();
  for (const sale of sales) {
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
  for (const sale of sales) {
    const staffName = sale.staff?.name || 'Unknown';
    const existing = staffTotals.get(staffName) || { staffName, total: 0, transactionCount: 0 };
    existing.total += sale.totalAmount;
    existing.transactionCount += 1;
    staffTotals.set(staffName, existing);
  }
  const byStaff = Array.from(staffTotals.values()).sort((a, b) => b.total - a.total);

  const [ratingAgg] = await Rating.aggregate([
    { $match: { shop: req.user.shop._id, createdAt: { $gte: rangeStart } } },
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
