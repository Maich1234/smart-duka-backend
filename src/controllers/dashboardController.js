import Product from '../models/Product.js';
import Sale from '../models/Sale.js';
import Rating from '../models/Rating.js';
import Shift from '../models/Shift.js';
import DailySummary from '../models/DailySummary.js';
import { generateDailySummary } from '../services/dailySummaryService.js';

const todayStr = () => new Date().toISOString().slice(0, 10);
const yesterdayStr = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const dayWindow = (offsetDays = 0) => {
  const start = new Date();
  start.setDate(start.getDate() + offsetDays);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const SALE_COUNTED = { $nin: ['voided', 'refunded'] };

const salesTotalsPipeline = (match) => [
  { $match: match },
  { $group: {
      _id: null,
      total: { $sum: '$totalAmount' },
      cashTotal: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$totalAmount', 0] } },
      mpesaTotal: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'mpesa'] }, '$totalAmount', 0] } },
      transactionCount: { $sum: 1 },
    }
  },
];

export const getOwnerDashboard = async (req, res) => {
  const shopId = req.user.shop._id;
  const today = todayStr();
  const yesterday = yesterdayStr();

  const [
    todaySummary,
    yesterdaySummary,
    totalProducts,
    lowStockItems,
    recentTransactions,
    openShiftsCount,
    ratingAggResult,
  ] = await Promise.all([
    // Source of truth for "today's" revenue/profit/expenses/top product —
    // the same generateDailySummary the Summary screen uses, so the two
    // screens can never disagree on what "today" means or which sale
    // statuses count as revenue.
    generateDailySummary(shopId, today),
    DailySummary.findOne({ shop: shopId, date: yesterday }).lean()
      .then((doc) => doc ?? generateDailySummary(shopId, yesterday)),
    Product.countDocuments({ shop: shopId }),
    Product.find({ shop: shopId, $expr: { $lte: ['$quantity', '$lowStockAlert'] } })
      .select('name quantity lowStockAlert')
      .sort({ quantity: 1 })
      .limit(10),
    Sale.find({ shop: shopId })
      .select('invoiceNumber totalAmount paymentMethod createdAt staff')
      .populate('staff', 'name')
      .sort({ createdAt: -1 })
      .limit(5),
    Shift.countDocuments({ shop: shopId, status: 'active' }),
    Rating.aggregate([
      { $match: { shop: shopId } },
      { $group: { _id: null, avgStars: { $avg: '$stars' }, totalRatings: { $sum: 1 } } },
    ]),
  ]);

  const topProduct = todaySummary.bestSellers[0]
    ? { name: todaySummary.bestSellers[0].name, quantity: todaySummary.bestSellers[0].quantity, revenue: todaySummary.bestSellers[0].revenue }
    : null;
  const ratingAgg = ratingAggResult[0];

  res.json({
    success: true,
    data: {
      todaySalesTotal: todaySummary.totals.revenue,
      cashSalesTotal: todaySummary.byMethod.cash?.total ?? 0,
      mpesaSalesTotal: todaySummary.byMethod.mpesa?.total ?? 0,
      transactionsToday: todaySummary.totals.transactions,
      yesterdaySalesTotal: yesterdaySummary.totals.revenue,
      todayProfit: todaySummary.totals.grossProfit,
      todayExpensesTotal: todaySummary.totals.expenses,
      topProduct,
      openShiftsCount,
      totalProducts,
      currentStockValue: todaySummary.inventory.stockValue,
      lowStockItems,
      recentTransactions,
      ratingSummary: {
        avgStars: ratingAgg?.avgStars || 0,
        totalRatings: ratingAgg?.totalRatings || 0,
      },
    },
  });
};

export const getStaffDashboard = async (req, res) => {
  const today = dayWindow(0);
  const yesterday = dayWindow(-1);
  const baseMatch = { shop: req.user.shop._id, staff: req.user._id, status: SALE_COUNTED };

  const [todaySales, yesterdaySales, recentSales] = await Promise.all([
    Sale.aggregate(salesTotalsPipeline({ ...baseMatch, createdAt: { $gte: today.start, $lte: today.end } })),
    Sale.aggregate(salesTotalsPipeline({ ...baseMatch, createdAt: { $gte: yesterday.start, $lte: yesterday.end } })),
    Sale.find({ shop: req.user.shop._id, staff: req.user._id })
      .select('invoiceNumber totalAmount paymentMethod createdAt')
      .sort({ createdAt: -1 })
      .limit(5),
  ]);

  const todayStats = todaySales[0] || { total: 0, cashTotal: 0, mpesaTotal: 0, transactionCount: 0 };

  res.json({
    success: true,
    data: {
      todaySalesTotal: todayStats.total,
      cashSalesTotal: todayStats.cashTotal,
      mpesaSalesTotal: todayStats.mpesaTotal,
      transactionsToday: todayStats.transactionCount,
      yesterdaySalesTotal: yesterdaySales[0]?.total ?? 0,
      recentSales,
    },
  });
};
