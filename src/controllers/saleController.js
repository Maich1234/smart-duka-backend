import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Sale from '../models/Sale.js';
import MpesaTransaction from '../models/MpesaTransaction.js';
import { signReceiptToken } from '../utils/receiptToken.js';
import { resolveSaleLine, SaleLineError } from '../services/pricingEngine.js';

export const createSale = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('record_sale')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const { items, paymentMethod, mpesaTransactionId, mpesaReceiptNumber } = req.body;
  const shop = req.user.shop._id;

  // For M-Pesa sales, verify or record the payment reference
  let mpesaTx = null;
  if (paymentMethod === 'mpesa') {
    if (mpesaTransactionId) {
      // Normal STK push flow — confirm the transaction succeeded
      mpesaTx = await MpesaTransaction.findOne({ _id: mpesaTransactionId, shop, status: 'success' });
      if (!mpesaTx) {
        return res.status(400).json({ success: false, message: 'M-Pesa payment not confirmed. Please wait for payment confirmation before recording the sale.' });
      }
      if (mpesaTx.saleId) {
        return res.status(400).json({ success: false, message: 'This M-Pesa transaction has already been linked to a sale.' });
      }
    } else if (mpesaReceiptNumber) {
      // Offline manual entry — staff entered the code from the customer's confirmation SMS.
      // Try to link to an existing Safaricom transaction if the callback has already arrived.
      mpesaTx = await MpesaTransaction.findOne({ mpesaReceiptNumber, shop }).catch(() => null);
      if (mpesaTx?.saleId) {
        return res.status(400).json({ success: false, message: 'This M-Pesa receipt has already been linked to a sale.' });
      }
    }
  }
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let totalAmount = 0;
    const saleItems = [];
    // Keeps every product/bundle-component doc touched during this sale in
    // memory so it's mutated and saved exactly once, even when referenced
    // by more than one cart line (e.g. shared bundle components).
    const productCache = new Map();

    for (const item of items) {
      const product = await Product.findOne({ _id: item.productId, shop }).session(session);
      if (!product) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: `Product with ID ${item.productId} not found in this shop`,
        });
      }
      productCache.set(product._id.toString(), product);

      let resolved;
      try {
        resolved = await resolveSaleLine(product, item, { shop, session, productCache });
      } catch (err) {
        await session.abortTransaction();
        session.endSession();
        if (err instanceof SaleLineError) {
          return res.status(err.status).json({ success: false, message: err.message });
        }
        throw err;
      }

      totalAmount += resolved.subtotal;
      saleItems.push({
        productId: product._id,
        productName: product.name,
        quantity: resolved.quantity,
        unitPrice: resolved.unitPrice,
        subtotal: resolved.subtotal,
        discountAmount: resolved.discountAmount || 0,
        appliedPromotionLabel: resolved.appliedPromotionLabel,
        variantId: resolved.variantId,
        variantName: resolved.variantName,
        unitOfMeasure: resolved.unitOfMeasure,
        productType: resolved.productType,
      });
    }

    for (const doc of productCache.values()) {
      await doc.save({ session });
    }

    const [sale] = await Sale.create([{
      shop,
      items: saleItems,
      totalAmount,
      paymentMethod,
      staff: req.user._id,
      ...(mpesaTx ? {
        mpesaTransactionId: mpesaTx._id,
        mpesaReceiptNumber: mpesaTx.mpesaReceiptNumber,
      } : mpesaReceiptNumber ? {
        // Offline manual entry — receipt number recorded as-is; no linked transaction yet
        mpesaReceiptNumber,
      } : {}),
    }], { session });

    await session.commitTransaction();

    // Link the M-Pesa transaction to this sale outside the session (best-effort)
    if (mpesaTx) {
      MpesaTransaction.findByIdAndUpdate(mpesaTx._id, { saleId: sale._id }).catch(() => {});
    }

    const saleObj = sale.toObject();
    saleObj.receiptToken = signReceiptToken(sale._id);
    res.status(201).json({ success: true, data: saleObj, message: 'Sale recorded successfully' });
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

export const getSales = async (req, res) => {
  const { startDate, endDate, staffId, paymentMethod, page = 1, limit = 20 } = req.query;
  const query = { shop: req.user.shop._id };

  if (req.user.role === 'owner') {
    if (staffId) query.staff = staffId;
  } else if (req.user.permissions?.includes('view_all_sales')) {
    if (staffId) query.staff = staffId;
  } else {
    query.staff = req.user._id;
  }

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }
  if (paymentMethod) query.paymentMethod = paymentMethod;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sales = await Sale.find(query)
    .populate('staff', 'name email')
    .skip(skip)
    .limit(parseInt(limit))
    .sort({ createdAt: -1 });
  const total = await Sale.countDocuments(query);

  res.json({
    success: true,
    data: sales,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
  });
};

export const getSaleById = async (req, res) => {
  const sale = await Sale.findOne({ _id: req.params.id, shop: req.user.shop._id }).populate('staff', 'name email');
  if (!sale) return res.status(404).json({ success: false, message: 'Sale not found' });
  if (req.user.role === 'staff' && !req.user.permissions?.includes('view_all_sales') && sale.staff._id.toString() !== req.user._id.toString()) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }
  const saleObj = sale.toObject();
  saleObj.receiptToken = signReceiptToken(sale._id);
  res.json({ success: true, data: saleObj });
};

export const getSalesStats = async (req, res) => {
  const shop = req.user.shop._id;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

  const baseQuery = req.user.role === 'owner' || req.user.permissions?.includes('view_all_sales')
    ? { shop }
    : { shop, staff: req.user._id };

  const [thisMonth, lastMonth] = await Promise.all([
    Sale.aggregate([
      { $match: { ...baseQuery, createdAt: { $gte: startOfMonth } } },
      {
        $group: {
          _id: null,
          total: { $sum: '$totalAmount' },
          cashTotal: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, '$totalAmount', 0] } },
          mpesaTotal: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'mpesa'] }, '$totalAmount', 0] } },
          cardTotal: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'card'] }, '$totalAmount', 0] } },
          cashCount: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, 1, 0] } },
          mpesaCount: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'mpesa'] }, 1, 0] } },
          cardCount: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'card'] }, 1, 0] } },
          transactionCount: { $sum: 1 },
        },
      },
    ]),
    Sale.aggregate([
      { $match: { ...baseQuery, createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } } },
      { $group: { _id: null, total: { $sum: '$totalAmount' } } },
    ]),
  ]);

  const cur = thisMonth[0] || { total: 0, cashTotal: 0, mpesaTotal: 0, cardTotal: 0, cashCount: 0, mpesaCount: 0, cardCount: 0, transactionCount: 0 };
  const lastTotal = lastMonth[0]?.total || 0;
  const percentageChange = lastTotal > 0
    ? Math.round(((cur.total - lastTotal) / lastTotal) * 1000) / 10
    : cur.total > 0 ? 100 : 0;

  res.json({
    success: true,
    data: {
      totalSales: cur.total,
      cashTotal: cur.cashTotal,
      mpesaTotal: cur.mpesaTotal,
      cardTotal: cur.cardTotal,
      cashCount: cur.cashCount,
      mpesaCount: cur.mpesaCount,
      cardCount: cur.cardCount,
      transactionCount: cur.transactionCount,
      avgSale: cur.transactionCount > 0 ? cur.total / cur.transactionCount : 0,
      percentageChange,
    },
  });
};

export const getMySales = async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sales = await Sale.find({ staff: req.user._id, shop: req.user.shop._id })
    .skip(skip)
    .limit(parseInt(limit))
    .sort({ createdAt: -1 });
  const total = await Sale.countDocuments({ staff: req.user._id, shop: req.user.shop._id });
  res.json({
    success: true,
    data: sales,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
  });
};