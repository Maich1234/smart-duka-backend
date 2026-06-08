import Product from '../models/Product.js';

export const getProducts = async (req, res) => {
  const { search, category, page = 1, limit = 20 } = req.query;
  const query = {};

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

  const products = await Product.find(query)
    .skip(skip)
    .limit(parseInt(limit))
    .sort({ createdAt: -1 });

  const total = await Product.countDocuments(query);

  const sanitizedProducts = products.map((product) => {
    const p = product.toObject();
    if (req.user.role === 'staff') {
      delete p.costPrice;
    }
    return p;
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
  const product = await Product.findById(req.params.id);
  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not found' });
  }

  const productObj = product.toObject();
  if (req.user.role === 'staff') {
    delete productObj.costPrice;
  }

  res.json({ success: true, data: productObj });
};

export const createProduct = async (req, res) => {
  const product = await Product.create(req.body);
  res.status(201).json({ success: true, data: product });
};

export const updateProduct = async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not found' });
  }

  const updatedProduct = await Product.findByIdAndUpdate(
    req.params.id,
    req.body,
    { new: true, runValidators: true }
  );

  res.json({ success: true, data: updatedProduct });
};

export const deleteProduct = async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not found' });
  }

  const Sale = (await import('../models/Sale.js')).default;
  const hasSales = await Sale.findOne({ 'items.productId': product._id });
  if (hasSales) {
    return res.status(400).json({
      success: false,
      message: 'Cannot delete product with existing sales history',
    });
  }

  await product.deleteOne();
  res.json({ success: true, message: 'Product deleted successfully' });
};

export const updateStock = async (req, res) => {
  const { quantity } = req.body;
  const product = await Product.findById(req.params.id);
  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not found' });
  }

  product.quantity = quantity;
  await product.save();

  res.json({ success: true, data: product });
};