import mongoose from 'mongoose';
import Sale from '../models/Sale.js';
import Product from '../models/Product.js';

const DEFAULT_WINDOW_DAYS = 30;
const STOCKOUT_SOON_DAYS = 7;

/**
 * Computes per-product sales velocity and predicted stockout date for a
 * shop, based on units sold over a rolling window (not the static
 * lowStockAlert field). Reused by the analytics endpoint and the Phase 4
 * cron-driven low-stock notifications, so this is the single source of
 * truth for "is this product about to run out".
 */
export const getDepletionAnalytics = async (shopId, { windowDays = DEFAULT_WINDOW_DAYS } = {}) => {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const shopObjectId = new mongoose.Types.ObjectId(shopId);

  const salesAgg = await Sale.aggregate([
    { $match: { shop: shopObjectId, status: { $nin: ['voided', 'refunded'] }, createdAt: { $gte: since } } },
    { $unwind: '$items' },
    { $group: { _id: '$items.productId', unitsSold: { $sum: '$items.quantity' } } },
  ]);
  const unitsSoldMap = new Map(salesAgg.map((s) => [s._id.toString(), s.unitsSold]));

  // Bundle/configurable products carry no stock of their own — depletion
  // tracking only makes sense for products that actually hold inventory.
  const products = await Product.find({ shop: shopId, trackInventory: true }).lean();

  const items = products.map((p) => {
    const unitsSold = unitsSoldMap.get(p._id.toString()) || 0;
    const avgDailyVelocity = unitsSold / windowDays;
    const daysUntilStockout = avgDailyVelocity > 0 ? p.quantity / avgDailyVelocity : null;
    return {
      productId: p._id,
      name: p.name,
      category: p.category,
      quantity: p.quantity,
      lowStockAlert: p.lowStockAlert,
      unitsSold,
      avgDailyVelocity,
      daysUntilStockout,
    };
  });

  const positiveVelocities = items.map((i) => i.avgDailyVelocity).filter((v) => v > 0).sort((a, b) => a - b);
  const percentileOf = (v) => {
    if (positiveVelocities.length === 0) return 0;
    let countBelow = 0;
    for (const x of positiveVelocities) {
      if (x < v) countBelow++;
    }
    return countBelow / positiveVelocities.length;
  };

  const classified = items.map((i) => {
    let movement = 'dead';
    if (i.avgDailyVelocity > 0) {
      const pct = percentileOf(i.avgDailyVelocity);
      movement = pct >= 0.66 ? 'fast' : pct >= 0.33 ? 'medium' : 'slow';
    }
    return { ...i, movement };
  });

  const fastMovers = classified.filter((i) => i.movement === 'fast').sort((a, b) => b.avgDailyVelocity - a.avgDailyVelocity).slice(0, 10);
  const slowMovers = classified.filter((i) => i.movement === 'slow' || i.movement === 'dead').sort((a, b) => a.avgDailyVelocity - b.avgDailyVelocity).slice(0, 10);
  const stockoutSoon = classified
    .filter((i) => i.daysUntilStockout != null && i.daysUntilStockout <= STOCKOUT_SOON_DAYS)
    .sort((a, b) => a.daysUntilStockout - b.daysUntilStockout);

  return { windowDays, items: classified, fastMovers, slowMovers, stockoutSoon };
};
