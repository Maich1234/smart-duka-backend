import Product from '../models/Product.js';
import Sale from '../models/Sale.js';
import Rating from '../models/Rating.js';

export const getOwnerDashboard = async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const todaySales = await Sale.aggregate([
    { $match: { shop: req.user.shop._id, createdAt: { $gte: startOfDay, $lte: endOfDay } } },
    { $group: {
        _id: null,
        total: { $sum: '$totalAmount' },
        cashTotal: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$totalAmount', 0] } },
        mpesaTotal: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'mpesa'] }, '$totalAmount', 0] } },
        transactionCount: { $sum: 1 },
      }
    }
  ]);

  const todayStats = todaySales[0] || { total: 0, cashTotal: 0, mpesaTotal: 0, transactionCount: 0 };
  const totalProducts = await Product.countDocuments({ shop: req.user.shop._id });

  const stockValueAgg = await Product.aggregate([
    { $match: { shop: req.user.shop._id } },
    { $group: { _id: null, totalValue: { $sum: { $multiply: ['$quantity', '$costPrice'] } } } }
  ]);
  const currentStockValue = stockValueAgg[0]?.totalValue || 0;

  const lowStockItems = await Product.find({
    shop: req.user.shop._id,
    $expr: { $lte: ['$quantity', '$lowStockAlert'] },
  }).limit(10);

  const recentTransactions = await Sale.find({ shop: req.user.shop._id })
    .populate('staff', 'name')
    .sort({ createdAt: -1 })
    .limit(10);

  const [ratingAgg] = await Rating.aggregate([
    { $match: { shop: req.user.shop._id } },
    { $group: { _id: null, avgStars: { $avg: '$stars' }, totalRatings: { $sum: 1 } } },
  ]);

  res.json({
    success: true,
    data: {
      todaySalesTotal: todayStats.total,
      cashSalesTotal: todayStats.cashTotal,
      mpesaSalesTotal: todayStats.mpesaTotal,
      transactionsToday: todayStats.transactionCount,
      totalProducts,
      currentStockValue,
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
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const todaySales = await Sale.aggregate([
    { $match: { shop: req.user.shop._id, staff: req.user._id, createdAt: { $gte: startOfDay, $lte: endOfDay } } },
    { $group: {
        _id: null,
        total: { $sum: '$totalAmount' },
        cashTotal: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$totalAmount', 0] } },
        mpesaTotal: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'mpesa'] }, '$totalAmount', 0] } },
        transactionCount: { $sum: 1 },
      }
    }
  ]);

  const todayStats = todaySales[0] || { total: 0, cashTotal: 0, mpesaTotal: 0, transactionCount: 0 };
  const recentSales = await Sale.find({ shop: req.user.shop._id, staff: req.user._id })
    .sort({ createdAt: -1 })
    .limit(10);

  res.json({
    success: true,
    data: {
      todaySalesTotal: todayStats.total,
      cashSalesTotal: todayStats.cashTotal,
      mpesaSalesTotal: todayStats.mpesaTotal,
      transactionsToday: todayStats.transactionCount,
      recentSales,
    },
  });
};