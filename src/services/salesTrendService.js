import mongoose from 'mongoose';
import Sale from '../models/Sale.js';

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
 * Extracted out of reportController.js so both GET /reports/sales and the
 * chat get_sales_trend tool bucket revenue identically.
 */
export function buildBuckets(period, now) {
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

/**
 * Revenue/transaction-count trend, bucketed daily (7d)/weekly (8wk)/monthly
 * (6mo) — aggregated in the database, not loaded into memory. Returns the
 * raw `buckets` (Date-typed boundaries) alongside the zero-filled `series`
 * so callers that also need `rangeEnd`/the current bucket (reportController)
 * don't have to recompute buildBuckets a second time.
 */
export const getSalesTrendSeries = async (shopId, { period = 'daily', now = new Date() } = {}) => {
  const resolvedPeriod = ['daily', 'weekly', 'monthly'].includes(period) ? period : 'daily';
  const buckets = buildBuckets(resolvedPeriod, now);
  const rangeStart = buckets[0].start;
  const rangeEnd = buckets[buckets.length - 1].end;
  const shop = new mongoose.Types.ObjectId(String(shopId));

  const dayMatch = { shop, status: { $nin: ['voided', 'refunded'] }, createdAt: { $gte: rangeStart, $lt: rangeEnd } };
  const boundaries = [...buckets.map((b) => b.start), rangeEnd];

  const [bucketAgg, costAgg] = await Promise.all([
    Sale.aggregate([
      { $match: dayMatch },
      {
        $bucket: {
          groupBy: '$createdAt',
          boundaries,
          output: {
            total: { $sum: '$totalAmount' },
            cashTotal: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$totalAmount', 0] } },
            mpesaTotal: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'mpesa'] }, '$totalAmount', 0] } },
            // Anything that is neither — Airtel, bank, a custom button. Without
            // this the cash+mpesa split silently failed to reconcile to `total`.
            otherTotal: {
              $sum: {
                $cond: [{ $in: ['$paymentMethod', ['cash', 'mpesa']] }, 0, '$totalAmount'],
              },
            },
            transactionCount: { $sum: 1 },
          },
        },
      },
    ]),
    // Cost of goods per bucket, same convention as dailySummaryService: cost
    // comes from items[].costTotal (snapshotted at sale time), falling back
    // to the product's *current* costPrice only for lines that predate that
    // field.
    Sale.aggregate([
      { $match: dayMatch },
      { $unwind: '$items' },
      {
        $lookup: { from: 'products', localField: 'items.productId', foreignField: '_id', as: 'product' },
      },
      {
        $bucket: {
          groupBy: '$createdAt',
          boundaries,
          output: {
            cost: {
              $sum: {
                $cond: [
                  { $eq: [{ $ifNull: ['$items.costTotal', null] }, null] },
                  { $multiply: ['$items.quantity', { $ifNull: [{ $arrayElemAt: ['$product.costPrice', 0] }, 0] }] },
                  '$items.costTotal',
                ],
              },
            },
          },
        },
      },
    ]),
  ]);

  // $bucket keys each group by its lower boundary; zero-fill buckets with no
  // sales so gaps are visible, not just totals.
  const aggByBucketStart = new Map(bucketAgg.map((b) => [new Date(b._id).getTime(), b]));
  const costByBucketStart = new Map(costAgg.map((b) => [new Date(b._id).getTime(), b.cost]));
  const series = buckets.map((bucket) => {
    const agg = aggByBucketStart.get(bucket.start.getTime());
    const total = agg?.total ?? 0;
    const cost = costByBucketStart.get(bucket.start.getTime()) ?? 0;
    return {
      label: bucket.label,
      date: bucket.start.toISOString(),
      total,
      cashTotal: agg?.cashTotal ?? 0,
      mpesaTotal: agg?.mpesaTotal ?? 0,
      otherTotal: agg?.otherTotal ?? 0,
      transactionCount: agg?.transactionCount ?? 0,
      // Estimated gross profit — see cost-of-goods comment above.
      profitTotal: Math.round((total - cost) * 100) / 100,
    };
  });

  return { period: resolvedPeriod, rangeStart: rangeStart.toISOString(), buckets, series };
};
