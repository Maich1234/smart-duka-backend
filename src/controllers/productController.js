import Product from '../models/Product.js';
import { logAudit } from '../services/auditLogService.js';
import { getActiveShift } from '../services/shiftService.js';
import { parsePagination } from '../utils/pagination.js';
import { escapeRegex } from '../utils/escapeRegex.js';
import { sanitizeForStaff, showsCommissionTo, mergeVariantsForStaff } from '../services/productVisibility.js';

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

/**
 * Ensures no enabled commission has a base price above the price it's measured
 * against. A floor above the selling price isn't a validation nicety — it means
 * the line can never clear the floor, so the owner would be configuring a
 * commission that silently always pays zero.
 *
 * Checks the product-level config and every variant override.
 */
const validateCommissions = ({ commission, sellingPrice, variants }) => {
  if (commission?.enabled && sellingPrice != null && commission.basePrice > sellingPrice) {
    return 'Commission base price cannot exceed the selling price';
  }
  for (const v of variants ?? []) {
    if (v.commission?.enabled && v.commission.basePrice > v.sellingPrice) {
      return `Commission base price for variant "${v.name}" cannot exceed its selling price`;
    }
  }
  return null;
};

/**
 * Distinct categories this shop has actually used, for the product form's
 * category picker — so a shop with "Beverages", "Snacks", "Toiletries" isn't
 * retyping them from scratch (and drifting into "beverage" / "Beverages "
 * duplicates) on every new product.
 */
export const getProductCategories = async (req, res) => {
  const categories = await Product.distinct('category', { shop: req.user.shop._id });
  res.json({
    success: true,
    data: categories.filter(Boolean).sort((a, b) => a.localeCompare(b)),
  });
};

export const getProducts = async (req, res) => {
  const { search, category, excludeTypes } = req.query;
  const { page, limit, skip } = parsePagination(req.query);
  const query = { shop: req.user.shop._id };

  if (search) {
    const pattern = { $regex: escapeRegex(search), $options: 'i' };
    query.$or = [
      { name: pattern },
      { description: pattern },
      { sku: pattern },
      { 'variants.sku': pattern },
      { barcode: pattern },
      { 'variants.barcode': pattern },
    ];
  }

  if (category) {
    query.category = { $regex: escapeRegex(category), $options: 'i' };
  }

  // Used by the Purchasing product picker to hide types that can't be
  // purchased directly (bundle/service — see purchaseStockService.js).
  if (excludeTypes) {
    query.productType = { $nin: String(excludeTypes).split(',').map((t) => t.trim()).filter(Boolean) };
  }

  const [products, total] = await Promise.all([
    Product.find(query).skip(skip).limit(limit).sort({ createdAt: -1 }),
    Product.countDocuments(query),
  ]);

  const sanitizedProducts = products.map((product) => {
    const p = product.toObject();
    return req.user.role === 'staff' ? sanitizeForStaff(p, showsCommissionTo(req.user)) : p;
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
  res.json({ success: true, data: req.user.role === 'staff' ? sanitizeForStaff(productObj, showsCommissionTo(req.user)) : productObj });
};

export const createProduct = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('create_product')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  // Commission is what the shop pays the seller, so only the owner sets it —
  // `create_product` is permission to maintain the catalogue, not to decide
  // one's own pay. Without this a staff member could create a product with
  // basePrice 0 and a 100% share and bank its entire selling price.
  //
  // Cost price is left alone: staff are entering a new product's figures
  // rather than overwriting one they were never shown.
  if (req.user.role !== 'owner') {
    delete req.body.commission;
    if (Array.isArray(req.body.variants)) {
      req.body.variants = req.body.variants.map(({ commission, ...rest }) => rest);
    }
  }

  const bundleError = await validateBundleItems(req.body.bundleItems, req.user.shop._id);
  if (bundleError) {
    return res.status(400).json({ success: false, message: bundleError });
  }

  const commissionError = validateCommissions(req.body);
  if (commissionError) {
    return res.status(400).json({ success: false, message: commissionError });
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

  // Staff never receive `costPrice` or `commission` — productVisibility.js
  // strips both before a product leaves the server. Whatever a staff client
  // sends back for them is therefore an artefact of a blank form, not an
  // intent, and this is a partial update (findByIdAndUpdate below overwrites
  // exactly the keys present): applying it would zero the shop's cost price
  // and silently switch commission off.
  //
  // This is enforcement, not just tidying — it is what makes `edit_product`
  // safe to grant. Clients hide the fields too, but the server is the one
  // guarantee that a stale or hostile client cannot erase margin data.
  if (req.user.role !== 'owner') {
    delete req.body.costPrice;
    delete req.body.commission;
    req.body.variants = mergeVariantsForStaff(req.body.variants, product.toObject().variants);
    if (req.body.variants === undefined) delete req.body.variants;
  }

  const bundleError = await validateBundleItems(req.body.bundleItems, req.user.shop._id);
  if (bundleError) {
    return res.status(400).json({ success: false, message: bundleError });
  }

  // Updates are partial: a request may change `commission` without resending
  // `sellingPrice` (or vice versa). Validate the merged result, or a floor
  // could be slipped above a price that simply wasn't in this payload.
  const commissionError = validateCommissions({
    commission: req.body.commission ?? product.commission,
    sellingPrice: req.body.sellingPrice ?? product.sellingPrice,
    variants: req.body.variants,
  });
  if (commissionError) {
    return res.status(400).json({ success: false, message: commissionError });
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