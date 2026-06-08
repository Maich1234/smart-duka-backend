import Product from '../models/Product.js';
import Sale from '../models/Sale.js';

export const getOwnerDashboard = async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const todaySales = await Sale.aggregate([
    {
      $match: {
        createdAt: { $gte: startOfDay, $lte: endOfDay },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$totalAmount' },
        cashTotal: {
          $sum: {
            $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$totalAmount', 0],
          },
        },
        mpesaTotal: {
          $sum: {
            $cond: [{ $eq: ['$paymentMethod', 'mpesa'] }, '$totalAmount', 0],
          },
        },
        transactionCount: { $sum: 1 },
      },
    },
  ]);

  const todayStats = todaySales[0] || {
    total: 0,
    cashTotal: 0,
    mpesaTotal: 0,
    transactionCount: 0,
  };

  const totalProducts = await Product.countDocuments();

  const stockValueAgg = await Product.aggregate([
    {
      $group: {
        _id: null,
        totalValue: { $sum: { $multiply: ['$quantity', '$costPrice'] } },
      },
    },
  ]);
  const currentStockValue = stockValueAgg[0]?.totalValue || 0;

  const lowStockItems = await Product.find({
    $expr: { $lte: ['$quantity', '$lowStockAlert'] },
  }).limit(10);

  const recentTransactions = await Sale.find()
    .populate('staff', 'name')
    .sort({ createdAt: -1 })
    .limit(10);

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
    },
  });
};

export const getStaffDashboard = async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const todaySales = await Sale.aggregate([
    {
      $match: {
        staff: req.user._id,
        createdAt: { $gte: startOfDay, $lte: endOfDay },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$totalAmount' },
        cashTotal: {
          $sum: {
            $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$totalAmount', 0],
          },
        },
        mpesaTotal: {
          $sum: {
            $cond: [{ $eq: ['$paymentMethod', 'mpesa'] }, '$totalAmount', 0],
          },
        },
        transactionCount: { $sum: 1 },
      },
    },
  ]);

  const todayStats = todaySales[0] || {
    total: 0,
    cashTotal: 0,
    mpesaTotal: 0,
    transactionCount: 0,
  };

  const recentSales = await Sale.find({ staff: req.user._id })
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