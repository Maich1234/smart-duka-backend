import Product from '../models/Product.js';
import { logAudit } from '../services/auditLogService.js';
import { getActiveShift } from '../services/shiftService.js';
import { parsePagination } from '../utils/pagination.js';
import { escapeRegex } from '../utils/escapeRegex.js';

const stripCostPrice = (product) => {
  delete product.costPrice;
  if (Array.isArray(product.variants)) {
    product.variants = product.variants.map(({ costPrice, ...rest }) => rest);
  }
  return product;
};

/** Ensures every bundleItems[].product reference belongs to the same shop. */
const validateBundleItems = async (bundleItems, shop) => {
  if (!bundleItems?.length) return null;
  const ids = bundleItems.map((b) => b.product);
  const count = await Product.countDocuments({ _id: { $in: ids }, shop });
  if (count !== new Set(ids.map(String)).size) {
    return 'One or more bundle items are invalid or belong to a different shop';
  }
  return null;
};

export const getProducts = async (req, res) => {
  const { search, category } = req.query;
  const { page, limit, skip } = parsePagination(req.query);
  const query = { shop: req.user.shop._id };

  if (search) {
    query.$or = [
      { name: { $regex: escapeRegex(search), $options: 'i' } },
      { description: { $regex: escapeRegex(search), $options: 'i' } },
    ];
  }

  if (category) {
    query.category = { $regex: escapeRegex(category), $options: 'i' };
  }

  const [products, total] = await Promise.all([
    Product.find(query).skip(skip).limit(limit).sort({ createdAt: -1 }),
    Product.countDocuments(query),
  ]);

  const sanitizedProducts = products.map((product) => {
    const p = product.toObject();
    return req.user.role === 'staff' ? stripCostPrice(p) : p;
  });

  res.json({
    success: true,
    data: sanitizedProducts,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
};

export const getProductById = async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, shop: req.user.shop._id });
  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not found' });
  }

  const productObj = product.toObject();
  res.json({ success: true, data: req.user.role === 'staff' ? stripCostPrice(productObj) : productObj });
};

export const createProduct = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('create_product')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const bundleError = await validateBundleItems(req.body.bundleItems, req.user.shop._id);
  if (bundleError) {
    return res.status(400).json({ success: false, message: bundleError });
  }

  const product = await Product.create({ ...req.body, shop: req.user.shop._id });
  res.status(201).json({ success: true, data: product });
};

export const updateProduct = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('edit_product')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const product = await Product.findOne({ _id: req.params.id, shop: req.user.shop._id });
  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not found' });
  }

  const bundleError = await validateBundleItems(req.body.bundleItems, req.user.shop._id);
  if (bundleError) {
    return res.status(400).json({ success: false, message: bundleError });
  }

  const updatedProduct = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  res.json({ success: true, data: updatedProduct });
};

export const deleteProduct = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('delete_product')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const product = await Product.findOne({ _id: req.params.id, shop: req.user.shop._id });
  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not found' });
  }

  const Sale = await import('../models/Sale.js').then(m => m.default);
  const hasSales = await Sale.findOne({ 'items.productId': product._id, shop: req.user.shop._id });
  if (hasSales) {
    return res.status(400).json({ success: false, message: 'Cannot delete product with existing sales history' });
  }

  await product.deleteOne();
  res.json({ success: true, message: 'Product deleted successfully' });
};

export const updateStock = async (req, res) => {
  const { quantity } = req.body;
  const product = await Product.findOne({ _id: req.params.id, shop: req.user.shop._id });
  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not found' });
  }

  if (req.user.role !== 'owner' && !req.user.permissions?.includes('edit_product_stock')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const previousQuantity = product.quantity;
  product.quantity = quantity;
  await product.save();

  // Manual stock corrections are a shrinkage signal — record who moved what,
  // and under which shift, so shift/daily reports can surface adjustments.
  const activeShift = req.user.shop?.shiftManagementEnabled
    ? await getActiveShift(req.user._id)
    : null;
  await logAudit({
    shopId: req.user.shop._id,
    userId: req.user._id,
    action: 'inventory.stock_adjusted',
    entityType: 'Product',
    entityId: product._id,
    details: {
      productName: product.name,
      from: previousQuantity,
      to: quantity,
      delta: quantity - previousQuantity,
      ...(activeShift ? { shiftId: String(activeShift._id) } : {}),
    },
    req,
  });

  res.json({ success: true, data: product });
};