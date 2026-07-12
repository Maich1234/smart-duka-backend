import mongoose from 'mongoose';
import Sale from '../models/Sale.js';
import Expense from '../models/Expense.js';
import Product from '../models/Product.js';
import Shift from '../models/Shift.js';
import MpesaTransaction from '../models/MpesaTransaction.js';
import AuditLog from '../models/AuditLog.js';
import DailySummary from '../models/DailySummary.js';

const SLOW_MOVER_WINDOW_DAYS = 7;

/** [startOfDay, endOfDay) for a YYYY-MM-DD string (UTC, matching the other crons). */
const dayWindow = (dateStr) => {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
};

const REVENUE_STATUSES = ['completed', 'refund_pending'];

/** Rule-based takeaways — plain sentences the owner can act on. */
const buildInsights = ({ totals, refunds, voids, shifts, inventory, bestSellers, mpesaReconciliation }) => {
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
  ] = await Promise.all([
    // Revenue + transaction counts per payment method
    Sale.aggregate([
      { $match: { ...dayMatch, status: { $in: REVENUE_STATUSES } } },
      { $group: { _id: '$paymentMethod', count: { $sum: 1 }, total: { $sum: '$totalAmount' } } },
    ]),
    // Per-product quantities/revenue + discount + cost estimate (current costPrice)
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
        },
      },
      { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
      {
        $addFields: {
          estCost: {
            $multiply: ['$quantity', { $ifNull: [{ $arrayElemAt: ['$product.costPrice', 0] }, 0] }],
          },
        },
      },
      { $project: { product: 0 } },
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
  doc.insights = buildInsights(doc);

  return DailySummary.findOneAndUpdate(
    { shop, date: dateStr },
    { $set: doc },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};
