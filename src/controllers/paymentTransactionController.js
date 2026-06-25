import MpesaTransaction from '../models/MpesaTransaction.js';

/** Lists M-Pesa transactions for the shop with filtering, search, and pagination. Owner only. */
export const getPaymentTransactions = async (req, res) => {
  const shopId = req.user.shop._id ?? req.user.shop;
  const { startDate, endDate, status, staffId, search, page = 1, limit = 20 } = req.query;

  const query = { shop: shopId };

  if (status) query.status = status;
  if (staffId) query.requestedBy = staffId;

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  if (search) {
    query.$or = [
      { phoneNumber: { $regex: search, $options: 'i' } },
      { mpesaReceiptNumber: { $regex: search, $options: 'i' } },
      { accountReference: { $regex: search, $options: 'i' } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [transactions, total] = await Promise.all([
    MpesaTransaction.find(query)
      .populate('requestedBy', 'name email')
      .populate('saleId', 'invoiceNumber totalAmount')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    MpesaTransaction.countDocuments(query),
  ]);

  // Summary stats
  const stats = await MpesaTransaction.aggregate([
    { $match: { shop: shopId } },
    {
      $group: {
        _id: null,
        totalVolume: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, '$amount', 0] } },
        successCount: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
        totalCount: { $sum: 1 },
      },
    },
  ]);

  const s = stats[0] || { totalVolume: 0, successCount: 0, totalCount: 0 };
  const successRate = s.totalCount > 0 ? Math.round((s.successCount / s.totalCount) * 100) : 0;

  res.json({
    success: true,
    data: transactions,
    stats: { totalVolume: s.totalVolume, successRate, successCount: s.successCount, totalCount: s.totalCount },
    pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
  });
};

/** Single transaction detail with linked sale. Owner only. */
export const getPaymentTransactionById = async (req, res) => {
  const shopId = req.user.shop._id ?? req.user.shop;
  const transaction = await MpesaTransaction.findOne({ _id: req.params.id, shop: shopId })
    .populate('requestedBy', 'name email')
    .populate('saleId', 'invoiceNumber totalAmount items createdAt');

  if (!transaction) return res.status(404).json({ success: false, message: 'Transaction not found' });
  res.json({ success: true, data: transaction });
};
