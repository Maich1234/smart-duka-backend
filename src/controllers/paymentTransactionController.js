import mongoose from 'mongoose';
import MpesaTransaction from '../models/MpesaTransaction.js';

/** Lists M-Pesa transactions for the shop with filtering, search, and pagination. Owner only. */
export const getPaymentTransactions = async (req, res) => {
  try {
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

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [transactions, total] = await Promise.all([
      MpesaTransaction.find(query)
        .populate('requestedBy', 'name email')
        .populate('saleId', 'invoiceNumber totalAmount')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      MpesaTransaction.countDocuments(query),
    ]);

    // Summary stats scoped to the whole shop (not just the filtered page)
    const shopObjectId = mongoose.Types.ObjectId.isValid(shopId)
      ? new mongoose.Types.ObjectId(shopId)
      : shopId;

    const stats = await MpesaTransaction.aggregate([
      { $match: { shop: shopObjectId } },
      {
        $group: {
          _id: null,
          totalVolume: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, '$amount', 0] } },
          successCount: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
          totalCount: { $sum: 1 },
        },
      },
    ]);

    const s = stats[0] ?? { totalVolume: 0, successCount: 0, totalCount: 0 };
    const successRate = s.totalCount > 0 ? Math.round((s.successCount / s.totalCount) * 100) : 0;

    return res.json({
      success: true,
      data: transactions,
      stats: { totalVolume: s.totalVolume, successRate, successCount: s.successCount, totalCount: s.totalCount },
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    console.error('[PaymentTransactions] Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch transactions.' });
  }
};

/** Single transaction detail with linked sale. Owner only. */
export const getPaymentTransactionById = async (req, res) => {
  try {
    const shopId = req.user.shop._id ?? req.user.shop;
    const transaction = await MpesaTransaction.findOne({ _id: req.params.id, shop: shopId })
      .populate('requestedBy', 'name email')
      .populate('saleId', 'invoiceNumber totalAmount items createdAt');

    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }
    return res.json({ success: true, data: transaction });
  } catch (err) {
    console.error('[PaymentTransaction] Error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch transaction.' });
  }
};
