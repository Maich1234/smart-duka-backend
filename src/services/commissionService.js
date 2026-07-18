import Sale from '../models/Sale.js';

// Voided/refunded sales are corrections — excluded the same way every other
// revenue aggregate in this codebase excludes them (see getSalesStats/getSalesReport).
const REVENUE_STATUSES = { $nin: ['voided', 'refunded'] };

/**
 * Aggregates a staff member's commission earnings for a shop over an
 * optional date range. Used both for a staff member viewing their own
 * earnings and for an owner viewing any staff member's earnings.
 */
export const getCommissionSummary = async (shop, staffId, { startDate, endDate } = {}) => {
  const match = { shop, staff: staffId, status: REVENUE_STATUSES };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = new Date(endDate);
  }

  const [[totals], byProduct] = await Promise.all([
    Sale.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalCommission: { $sum: '$totalCommission' },
          totalRevenue: { $sum: '$totalAmount' },
          salesCount: { $sum: 1 },
        },
      },
    ]),
    Sale.aggregate([
      { $match: match },
      { $unwind: '$items' },
      { $match: { 'items.commissionAmount': { $gt: 0 } } },
      {
        $group: {
          _id: { productId: '$items.productId', variantId: '$items.variantId' },
          productName: { $first: '$items.productName' },
          variantName: { $first: '$items.variantName' },
          commission: { $sum: '$items.commissionAmount' },
          unitsSold: { $sum: '$items.quantity' },
        },
      },
      { $sort: { commission: -1 } },
    ]),
  ]);

  return {
    totalCommission: totals?.totalCommission || 0,
    totalRevenue: totals?.totalRevenue || 0,
    salesCount: totals?.salesCount || 0,
    byProduct: byProduct.map((p) => ({
      productId: p._id.productId,
      variantId: p._id.variantId,
      productName: p.productName,
      variantName: p.variantName,
      commission: p.commission,
      unitsSold: p.unitsSold,
    })),
  };
};
