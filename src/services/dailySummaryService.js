import mongoose from 'mongoose';
import Sale from '../models/Sale.js';
import Expense from '../models/Expense.js';
import Product from '../models/Product.js';
import Shift from '../models/Shift.js';
import MpesaTransaction from '../models/MpesaTransaction.js';
import AuditLog from '../models/AuditLog.js';
import DailySummary from '../models/DailySummary.js';
import { generateDailyInsights } from './intelligence/insightEngine.js';

const SLOW_MOVER_WINDOW_DAYS = 7;
const TRAILING_INSIGHT_DAYS = 7;

/** [startOfDay, endOfDay) for a YYYY-MM-DD string (UTC, matching the other crons). */
const dayWindow = (dateStr) => {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
};

const REVENUE_STATUSES = ['completed', 'refund_pending'];

/**
 * Compiles (and upserts) the end-of-day business summary for a shop.
 * Idempotent per (shop, date) — safe to re-run to refresh today's numbers.
 */
export const generateDailySummary = async (shopId, dateStr) => {
  const shop = new mongoose.Types.ObjectId(String(shopId));
  const { start, end } = dayWindow(dateStr);
  const dayMatch = { shop, createdAt: { $gte: start, $lt: end } };

  const [
    methodAgg,
    itemAgg,
    refundAgg,
    voidAgg,
    staffAgg,
    expenseAgg,
    shiftsClosed,
    shiftsOpen,
    lowStockCount,
    stockAgg,
    adjustmentAgg,
    mpesaAgg,
    soldRecently,
    trailingSummaries,
  ] = await Promise.all([
    // Revenue + transaction counts per payment method
    Sale.aggregate([
      { $match: { ...dayMatch, status: { $in: REVENUE_STATUSES } } },
      { $group: { _id: '$paymentMethod', count: { $sum: 1 }, total: { $sum: '$totalAmount' } } },
    ]),
    // Per-product quantities/revenue/discount + cost of goods.
    //
    // Cost comes from items[].costTotal — the cost snapshotted when the sale was
    // rung up. Only lines predating that field (costTotal null) fall back to the
    // product's *current* costPrice, which purchasing rewrites on every landed-
    // cost allocation and which therefore makes a past day's profit drift.
    Sale.aggregate([
      { $match: { ...dayMatch, status: { $in: REVENUE_STATUSES } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.productId',
          name: { $last: '$items.productName' },
          quantity: { $sum: '$items.quantity' },
          revenue: { $sum: '$items.subtotal' },
          discounts: { $sum: { $ifNull: ['$items.discountAmount', 0] } },
          snapshotCost: { $sum: { $ifNull: ['$items.costTotal', 0] } },
          // Quantity still needing the fallback, so the lookup is applied to
          // exactly those units rather than to the whole group.
          unsnapshottedQuantity: {
            $sum: {
              $cond: [{ $eq: [{ $ifNull: ['$items.costTotal', null] }, null] }, '$items.quantity', 0],
            },
          },
        },
      },
      { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
      {
        $addFields: {
          estCost: {
            $add: [
              '$snapshotCost',
              {
                $multiply: [
                  '$unsnapshottedQuantity',
                  { $ifNull: [{ $arrayElemAt: ['$product.costPrice', 0] }, 0] },
                ],
              },
            ],
          },
        },
      },
      { $project: { product: 0, snapshotCost: 0, unsnapshottedQuantity: 0 } },
      { $sort: { quantity: -1 } },
    ]),
    Sale.aggregate([
      { $match: { ...dayMatch, status: 'refunded' } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: { $ifNull: ['$refund.amount', '$totalAmount'] } } } },
    ]),
    Sale.aggregate([
      { $match: { ...dayMatch, status: 'voided' } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$totalAmount' } } },
    ]),
    Sale.aggregate([
      { $match: { ...dayMatch, status: { $in: REVENUE_STATUSES } } },
      { $group: { _id: '$staff', salesCount: { $sum: 1 }, revenue: { $sum: '$totalAmount' } } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $project: { salesCount: 1, revenue: 1, name: { $arrayElemAt: ['$user.name', 0] } } },
      { $sort: { revenue: -1 } },
    ]),
    Expense.aggregate([
      { $match: { shop, date: { $gte: start, $lt: end } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Shift.find({ shop, status: 'closed', endedAt: { $gte: start, $lt: end } }).select('summary').lean(),
    Shift.countDocuments({ shop, status: 'active', startedAt: { $lt: end } }),
    Product.countDocuments({ shop, isActive: { $ne: false }, $expr: { $lte: ['$quantity', '$lowStockAlert'] } }),
    Product.aggregate([
      { $match: { shop } },
      { $group: { _id: null, value: { $sum: { $multiply: [{ $ifNull: ['$quantity', 0] }, { $ifNull: ['$costPrice', 0] }] } } } },
    ]),
    AuditLog.countDocuments({ shopId: shop, action: 'inventory.stock_adjusted', createdAt: { $gte: start, $lt: end } }),
    MpesaTransaction.aggregate([
      { $match: { shop, status: 'success', createdAt: { $gte: start, $lt: end } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    // Products that sold at all in the trailing window — everything else with
    // stock on hand is a slow mover.
    Sale.aggregate([
      { $match: { shop, createdAt: { $gte: new Date(end.getTime() - SLOW_MOVER_WINDOW_DAYS * 86400000), $lt: end }, status: { $in: REVENUE_STATUSES } } },
      { $unwind: '$items' },
      { $group: { _id: '$items.productId' } },
    ]),
    // Most-recent-first, excluding today — feeds the trailing-average
    // comparisons in insightEngine.generateDailyInsights.
    DailySummary.find({ shop, date: { $lt: dateStr } })
      .sort({ date: -1 })
      .limit(TRAILING_INSIGHT_DAYS)
      .lean(),
  ]);

  const byMethod = { cash: { count: 0, total: 0 }, mpesa: { count: 0, total: 0 }, card: { count: 0, total: 0 } };
  let revenue = 0;
  let transactions = 0;
  for (const m of methodAgg) {
    if (byMethod[m._id]) byMethod[m._id] = { count: m.count, total: m.total };
    revenue += m.total;
    transactions += m.count;
  }

  const discounts = itemAgg.reduce((sum, i) => sum + (i.discounts || 0), 0);
  const grossProfit = itemAgg.reduce((sum, i) => sum + (i.revenue - i.estCost), 0);

  const bestSellers = itemAgg.slice(0, 5).map((i) => ({
    productId: i._id,
    name: i.name,
    quantity: i.quantity,
    revenue: i.revenue,
  }));

  const soldIds = new Set(soldRecently.map((s) => String(s._id)));
  const slowMoverDocs = await Product.find({
    shop,
    isActive: { $ne: false },
    quantity: { $gt: 0 },
    _id: { $nin: [...soldIds].map((id) => new mongoose.Types.ObjectId(id)) },
  })
    .sort({ quantity: -1 })
    .limit(5)
    .select('name quantity')
    .lean();

  const shiftDiscrepancy = shiftsClosed.reduce((sum, s) => sum + (s.summary?.cashDiscrepancy ?? 0), 0);

  const refunds = { count: refundAgg[0]?.count ?? 0, total: refundAgg[0]?.total ?? 0 };
  const voids = { count: voidAgg[0]?.count ?? 0, total: voidAgg[0]?.total ?? 0 };
  const mpesaConfirmed = mpesaAgg[0]?.total ?? 0;

  const doc = {
    shop,
    date: dateStr,
    totals: {
      revenue,
      transactions,
      discounts,
      grossProfit: Math.round(grossProfit * 100) / 100,
      expenses: expenseAgg[0]?.total ?? 0,
    },
    byMethod,
    refunds,
    voids,
    shifts: {
      count: shiftsClosed.length,
      totalDiscrepancy: Math.round(shiftDiscrepancy * 100) / 100,
      unclosed: shiftsOpen,
    },
    inventory: {
      lowStockCount,
      adjustments: adjustmentAgg,
      stockValue: stockAgg[0]?.value ?? 0,
    },
    bestSellers,
    slowMovers: slowMoverDocs.map((p) => ({ productId: p._id, name: p.name, quantity: 0, stock: p.quantity })),
    staffPerformance: staffAgg.map((s) => ({ staffId: s._id, name: s.name, salesCount: s.salesCount, revenue: s.revenue })),
    mpesaReconciliation: {
      salesTotal: byMethod.mpesa.total,
      confirmedTotal: mpesaConfirmed,
      delta: Math.round((byMethod.mpesa.total - mpesaConfirmed) * 100) / 100,
    },
    generatedAt: new Date(),
  };
  doc.insights = generateDailyInsights(doc, trailingSummaries);

  return DailySummary.findOneAndUpdate(
    { shop, date: dateStr },
    { $set: doc },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};
