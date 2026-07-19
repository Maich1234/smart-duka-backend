import Supplier from '../models/Supplier.js';
import Purchase from '../models/Purchase.js';
import { parsePagination } from '../utils/pagination.js';
import { escapeRegex } from '../utils/escapeRegex.js';

export const getSuppliers = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('view_purchases')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const { search } = req.query;
  const { page, limit, skip } = parsePagination(req.query);
  const query = { shop: req.user.shop._id, isActive: true };
  if (search) {
    query.name = { $regex: escapeRegex(search), $options: 'i' };
  }

  const [suppliers, total] = await Promise.all([
    Supplier.find(query).skip(skip).limit(limit).sort({ name: 1 }),
    Supplier.countDocuments(query),
  ]);

  res.json({
    success: true,
    data: suppliers,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

export const getSupplierById = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('view_purchases')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const supplier = await Supplier.findOne({ _id: req.params.id, shop: req.user.shop._id });
  if (!supplier) return res.status(404).json({ success: false, message: 'Supplier not found' });

  const [stats] = await Purchase.aggregate([
    { $match: { shop: req.user.shop._id, supplier: supplier._id, status: 'completed' } },
    {
      $group: {
        _id: null,
        purchaseCount: { $sum: 1 },
        totalSpend: { $sum: '$grandTotal' },
        lastPurchaseDate: { $max: '$createdAt' },
      },
    },
  ]);

  const recentPurchases = await Purchase.find({ shop: req.user.shop._id, supplier: supplier._id, status: { $ne: 'cancelled' } })
    .sort({ createdAt: -1 })
    .limit(5);

  const purchaseCount = stats?.purchaseCount ?? 0;
  res.json({
    success: true,
    data: {
      ...supplier.toObject(),
      stats: {
        purchaseCount,
        totalSpend: stats?.totalSpend ?? 0,
        averagePurchaseCost: purchaseCount > 0 ? (stats.totalSpend / purchaseCount) : 0,
        lastPurchaseDate: stats?.lastPurchaseDate ?? null,
      },
      recentPurchases,
    },
  });
};

export const createSupplier = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('create_purchases')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const supplier = await Supplier.create({ ...req.body, shop: req.user.shop._id });
  res.status(201).json({ success: true, data: supplier });
};

export const updateSupplier = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('edit_purchases')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const supplier = await Supplier.findOne({ _id: req.params.id, shop: req.user.shop._id });
  if (!supplier) return res.status(404).json({ success: false, message: 'Supplier not found' });

  Object.assign(supplier, req.body);
  await supplier.save();
  res.json({ success: true, data: supplier });
};

// Soft-delete — suppliers are referenced by historical purchases, so the
// record is kept (hidden from the picker) rather than removed.
export const deleteSupplier = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('delete_purchases')) {
    return res.status(403).json({ success: false, message: 'Permission denied' });
  }

  const supplier = await Supplier.findOne({ _id: req.params.id, shop: req.user.shop._id });
  if (!supplier) return res.status(404).json({ success: false, message: 'Supplier not found' });

  supplier.isActive = false;
  await supplier.save();
  res.json({ success: true, message: 'Supplier removed' });
};
