import mongoose from 'mongoose';
import Purchase from '../models/Purchase.js';
import { buildBuckets } from './salesTrendService.js';

// Purchases in these statuses have no real business-facing footprint —
// pending ones haven't touched stock/cost yet, cancelled ones were undone.
const LIVE_STATUSES = ['completed', 'pending_approval'];
const SPEND_STATUSES = ['completed'];

const staffScopedQuery = (req) => {
  const shop = req.user.shop._id;
  if (req.user.role === 'owner' || req.user.permissions?.includes('view_purchases')) {
    return { shop };
  }
  return { shop, staff: req.user._id };
};

/**
 * Today's-numbers for the Purchasing home dashboard: purchases recorded,
 * amount spent, distinct products/suppliers touched, plus a short recent list.
 * Only 'completed' purchases count toward spend (pending-approval purchases
 * haven't actually landed yet; cancelled ones were undone).
 */
export const getPurchaseStats = async (shopId, { staffId } = {}) => {
  const shop = new mongoose.Types.ObjectId(String(shopId));
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const match = { shop, createdAt: { $gte: startOfToday }, status: { $in: LIVE_STATUSES } };
  if (staffId) match.staff = new mongoose.Types.ObjectId(String(staffId));

  const [agg] = await Purchase.aggregate([
    { $match: match },
    {
      $facet: {
        totals: [
          { $match: { status: { $in: SPEND_STATUSES } } },
          {
            $group: {
              _id: null,
              purchaseCount: { $sum: 1 },
              totalSpend: { $sum: '$grandTotal' },
              productsPurchased: { $sum: { $size: '$items' } },
            },
          },
        ],
        suppliers: [{ $match: { supplier: { $ne: null } } }, { $group: { _id: '$supplier' } }],
      },
    },
  ]);

  const totals = agg?.totals?.[0] ?? { purchaseCount: 0, totalSpend: 0, productsPurchased: 0 };
  const recentPurchases = await Purchase.find({ shop, status: { $in: LIVE_STATUSES } })
    .populate('staff', 'name')
    .sort({ createdAt: -1 })
    .limit(5);

  return {
    purchaseCount: totals.purchaseCount,
    totalSpend: totals.totalSpend,
    productsPurchased: totals.productsPurchased,
    suppliersUsed: agg?.suppliers?.length ?? 0,
    recentPurchases,
  };
};

/**
 * Procurement volume/spend trend bucketed daily (7d)/weekly (8wk)/monthly
 * (6mo) — reuses buildBuckets from salesTrendService.js so purchase and sale
 * trend charts always bucket time identically.
 */
export const getPurchaseTrendSeries = async (shopId, { period = 'daily', now = new Date() } = {}) => {
  const resolvedPeriod = ['daily', 'weekly', 'monthly'].includes(period) ? period : 'daily';
  const buckets = buildBuckets(resolvedPeriod, now);
  const rangeStart = buckets[0].start;
  const rangeEnd = buckets[buckets.length - 1].end;
  const shop = new mongoose.Types.ObjectId(String(shopId));

  const bucketAgg = await Purchase.aggregate([
    { $match: { shop, status: 'completed', createdAt: { $gte: rangeStart, $lt: rangeEnd } } },
    {
      $bucket: {
        groupBy: '$createdAt',
        boundaries: [...buckets.map((b) => b.start), rangeEnd],
        output: {
          productsTotal: { $sum: '$productsTotal' },
          additionalCostsTotal: { $sum: '$additionalCostsTotal' },
          grandTotal: { $sum: '$grandTotal' },
          purchaseCount: { $sum: 1 },
        },
      },
    },
  ]);

  const aggByBucketStart = new Map(bucketAgg.map((b) => [new Date(b._id).getTime(), b]));
  const series = buckets.map((bucket) => {
    const agg = aggByBucketStart.get(bucket.start.getTime());
    return {
      label: bucket.label,
      date: bucket.start.toISOString(),
      productsTotal: agg?.productsTotal ?? 0,
      additionalCostsTotal: agg?.additionalCostsTotal ?? 0,
      grandTotal: agg?.grandTotal ?? 0,
      purchaseCount: agg?.purchaseCount ?? 0,
    };
  });

  return { period: resolvedPeriod, rangeStart: rangeStart.toISOString(), series };
};

/**
 * Procurement Analytics screen data: cost breakdown by category, top
 * purchased products, and spend by supplier, all over the same bucketed
 * range as getPurchaseTrendSeries (so the two sections describe one period).
 */
export const getPurchaseAnalytics = async (shopId, { period = 'monthly', now = new Date() } = {}) => {
  const resolvedPeriod = ['daily', 'weekly', 'monthly'].includes(period) ? period : 'monthly';
  const buckets = buildBuckets(resolvedPeriod, now);
  const rangeStart = buckets[0].start;
  const rangeEnd = buckets[buckets.length - 1].end;
  const shop = new mongoose.Types.ObjectId(String(shopId));
  const match = { shop, status: 'completed', createdAt: { $gte: rangeStart, $lt: rangeEnd } };

  const [trend, costBreakdown, topProducts, supplierSpend] = await Promise.all([
    getPurchaseTrendSeries(shopId, { period: resolvedPeriod, now }),
    Purchase.aggregate([
      { $match: match },
      { $unwind: '$additionalCosts' },
      { $group: { _id: '$additionalCosts.category', amount: { $sum: '$additionalCosts.amount' } } },
      { $sort: { amount: -1 } },
    ]),
    Purchase.aggregate([
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.productId',
          productName: { $last: '$items.productName' },
          quantity: { $sum: '$items.quantity' },
          totalCost: { $sum: '$items.totalCost' },
        },
      },
      { $sort: { totalCost: -1 } },
      { $limit: 10 },
    ]),
    Purchase.aggregate([
      { $match: { ...match, supplier: { $ne: null } } },
      {
        $group: {
          _id: '$supplier',
          purchaseCount: { $sum: 1 },
          totalSpend: { $sum: '$grandTotal' },
        },
      },
      { $lookup: { from: 'suppliers', localField: '_id', foreignField: '_id', as: 'supplier' } },
      { $unwind: { path: '$supplier', preserveNullAndEmptyArrays: true } },
      { $addFields: { supplierName: '$supplier.name' } },
      { $project: { supplier: 0 } },
      { $sort: { totalSpend: -1 } },
    ]),
  ]);

  const totalInventoryPurchased = trend.series.reduce((sum, b) => sum + b.productsTotal, 0);
  const totalAdditionalCosts = trend.series.reduce((sum, b) => sum + b.additionalCostsTotal, 0);
  const totalProcurementCost = trend.series.reduce((sum, b) => sum + b.grandTotal, 0);
  const purchaseCount = trend.series.reduce((sum, b) => sum + b.purchaseCount, 0);

  return {
    period: resolvedPeriod,
    rangeStart: rangeStart.toISOString(),
    series: trend.series,
    summary: {
      totalInventoryPurchased,
      totalAdditionalCosts,
      totalProcurementCost,
      averageProcurementCost: purchaseCount > 0 ? totalProcurementCost / purchaseCount : 0,
    },
    costBreakdown: costBreakdown.map((c) => ({ category: c._id, amount: c.amount })),
    topProducts,
    supplierSpend,
  };
};

export { staffScopedQuery };
