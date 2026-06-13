import mongoose from 'mongoose';
import Product from '../models/Product.js';
import Sale from '../models/Sale.js';

export const createSale = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('record_sale')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const { items, paymentMethod } = req.body;
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let totalAmount = 0;
    const saleItems = [];

    for (const item of items) {
      const product = await Product.findOne({ _id: item.productId, shop: req.user.shop._id }).session(session);
      if (!product) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: `Product with ID ${item.productId} not found in this shop`,
        });
      }
      if (product.quantity < item.quantity) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${product.name}. Available: ${product.quantity}`,
        });
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

    const [sale] = await Sale.create([{
      shop: req.user.shop._id,
      items: saleItems,
      totalAmount,
      paymentMethod,
      staff: req.user._id,
    }], { session });

    await session.commitTransaction();
    res.status(201).json({ success: true, data: sale, message: 'Sale recorded successfully' });
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
  res.json({ success: true, data: sale });
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