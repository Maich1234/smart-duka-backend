import Product from '../models/Product.js';

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
  const { search, category, page = 1, limit = 20 } = req.query;
  const query = { shop: req.user.shop._id };

  if (search) {
    query.$or = [
      { name: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } },
    ];
  }

  if (category) {
    query.category = { $regex: category, $options: 'i' };
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const products = await Product.find(query).skip(skip).limit(parseInt(limit)).sort({ createdAt: -1 });
  const total = await Product.countDocuments(query);

  const sanitizedProducts = products.map((product) => {
    const p = product.toObject();
    return req.user.role === 'staff' ? stripCostPrice(p) : p;
  });

  res.json({
    success: true,
    data: sanitizedProducts,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit)),
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

  product.quantity = quantity;
  await product.save();
  res.json({ success: true, data: product });
};