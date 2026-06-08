import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Sale from '../models/Sale.js';

export const createSale = async (req, res) => {
  const { items, paymentMethod } = req.body;

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let totalAmount = 0;
    const saleItems = [];

    for (const item of items) {
      const product = await Product.findById(item.productId).session(session);
      if (!product) {
        throw new Error(`Product ${item.productId} not found`);
      }

      if (product.quantity < item.quantity) {
        throw new Error(`Insufficient stock for ${product.name}. Available: ${product.quantity}`);
      }

      const subtotal = product.sellingPrice * item.quantity;
      totalAmount += subtotal;

      saleItems.push({
        productId: product._id,
        productName: product.name,
        quantity: item.quantity,
        unitPrice: product.sellingPrice,
        subtotal,
      });

      product.quantity -= item.quantity;
      await product.save({ session });
    }

    const sale = await Sale.create(
      [
        {
          items: saleItems,
          totalAmount,
          paymentMethod,
          staff: req.user._id,
        },
      ],
      { session }
    );

    await session.commitTransaction();

    res.status(201).json({
      success: true,
      data: sale[0],
      message: 'Sale recorded successfully',
    });
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

export const getSales = async (req, res) => {
  const { startDate, endDate, staffId, paymentMethod, page = 1, limit = 20 } = req.query;
  const query = {};

  if (req.user.role === 'staff') {
    query.staff = req.user._id;
  } else if (staffId) {
    query.staff = staffId;
  }

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  if (paymentMethod) {
    query.paymentMethod = paymentMethod;
  }

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
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit)),
    },
  });
};

export const getSaleById = async (req, res) => {
  const sale = await Sale.findById(req.params.id).populate('staff', 'name email');

  if (!sale) {
    return res.status(404).json({ success: false, message: 'Sale not found' });
  }

  if (req.user.role === 'staff' && sale.staff._id.toString() !== req.user._id.toString()) {
    return res.status(403).json({ success: false, message: 'Access denied' });
  }

  res.json({ success: true, data: sale });
};

export const getMySales = async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const sales = await Sale.find({ staff: req.user._id })
    .skip(skip)
    .limit(parseInt(limit))
    .sort({ createdAt: -1 });

  const total = await Sale.countDocuments({ staff: req.user._id });

  res.json({
    success: true,
    data: sales,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit)),
    },
  });
};