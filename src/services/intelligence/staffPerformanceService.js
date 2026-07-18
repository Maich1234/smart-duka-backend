import mongoose from 'mongoose';
import Sale from '../../models/Sale.js';

const REVENUE_STATUSES = ['completed', 'refund_pending'];
const DEFAULT_WINDOW_DAYS = 30;

/**
 * Per-staff sales count/revenue/commission over a date range, defaulting to
 * the trailing 30 days. Backs the chat get_staff_performance tool — neither
 * businessSnapshotBuilder (today-only) nor dailySummaryService
 * (single-day) can answer a "how's staff doing this month" question, and
 * this isn't extracted from dailySummaryService's staffAgg since that one
 * is embedded in a dense Promise.all of ten other day-scoped aggregates.
 */
export const getStaffPerformance = async (shopId, { startDate, endDate } = {}) => {
  const shop = new mongoose.Types.ObjectId(String(shopId));
  const end = endDate ? new Date(`${endDate}T23:59:59.999Z`) : new Date();
  const start = startDate
    ? new Date(`${startDate}T00:00:00.000Z`)
    : new Date(end.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const staffAgg = await Sale.aggregate([
    { $match: { shop, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: start, $lte: end } } },
    {
      $group: {
        _id: '$staff',
        salesCount: { $sum: 1 },
        revenue: { $sum: '$totalAmount' },
        commission: { $sum: '$totalCommission' },
      },
    },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
    { $project: { salesCount: 1, revenue: 1, commission: 1, name: { $arrayElemAt: ['$user.name', 0] } } },
    { $sort: { revenue: -1 } },
  ]);

  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    staff: staffAgg.map((s) => ({
      staffId: s._id,
      name: s.name ?? 'Unknown',
      salesCount: s.salesCount,
      revenue: s.revenue,
      commission: s.commission ?? 0,
    })),
  };
};
