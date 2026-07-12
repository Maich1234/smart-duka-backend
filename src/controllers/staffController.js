import User from '../models/User.js';
import { DEFAULT_STAFF_PERMISSIONS, withImpliedPermissions } from '../constants/permissions.js';
import { parsePagination } from '../utils/pagination.js';
import { escapeRegex } from '../utils/escapeRegex.js';

export const getStaff = async (req, res) => {
  const { search, startDate, endDate } = req.query;
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 10 });
  const query = { role: 'staff', shop: req.user.shop._id };
  if (search) {
    query.$or = [
      { name: { $regex: escapeRegex(search), $options: 'i' } },
      { email: { $regex: escapeRegex(search), $options: 'i' } },
    ];
  }
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }
  const [staff, total] = await Promise.all([
    User.find(query).select('-password').sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(query),
  ]);
  res.json({
    success: true,
    data: staff,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

export const getStaffById = async (req, res) => {
  const staff = await User.findOne({ _id: req.params.id, role: 'staff', shop: req.user.shop._id }).select('-password');
  if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });
  res.json({ success: true, data: staff });
};

export const createStaff = async (req, res) => {
  const { email } = req.body;
  const existingUser = await User.findOne({ email });
  if (existingUser) return res.status(400).json({ success: false, message: 'Email already exists' });

  const staff = await User.create({
    ...req.body,
    role: 'staff',
    shop: req.user.shop._id,
    isActive: true,
    permissions: withImpliedPermissions(req.body.permissions ?? DEFAULT_STAFF_PERMISSIONS),
  });

  const staffResponse = staff.toObject();
  delete staffResponse.password;
  res.status(201).json({ success: true, data: staffResponse });
};

export const updateStaff = async (req, res) => {
  const staff = await User.findOne({ _id: req.params.id, role: 'staff', shop: req.user.shop._id });
  if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });

  const { name, email, phone, isActive, permissions } = req.body;
  if (name) staff.name = name;
  if (email) staff.email = email;
  if (phone) staff.phone = phone;
  if (isActive !== undefined) staff.isActive = isActive;
  if (permissions) staff.permissions = withImpliedPermissions(permissions);

  await staff.save();
  const staffResponse = staff.toObject();
  delete staffResponse.password;
  res.json({ success: true, data: staffResponse });
};

export const deleteStaff = async (req, res) => {
  const staff = await User.findOne({ _id: req.params.id, role: 'staff', shop: req.user.shop._id });
  if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });

  await staff.deleteOne();
  res.json({ success: true, message: 'Staff deleted successfully' });
};

export const resetStaffPassword = async (req, res) => {
  const { newPassword } = req.body;
  const staff = await User.findOne({ _id: req.params.id, role: 'staff', shop: req.user.shop._id });
  if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });

  staff.password = newPassword;
  await staff.save();
  res.json({ success: true, message: 'Password reset successfully' });
};

export const getStaffSales = async (req, res) => {
  const Sale = (await import('../models/Sale.js')).default;
  const staff = await User.findOne({ _id: req.params.id, role: 'staff', shop: req.user.shop._id });
  if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });

  const { startDate, endDate } = req.query;
  const { page, limit, skip } = parsePagination(req.query);
  const query = { staff: staff._id, shop: req.user.shop._id };
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  const [sales, total] = await Promise.all([
    Sale.find(query).skip(skip).limit(limit).sort({ createdAt: -1 }),
    Sale.countDocuments(query),
  ]);

  res.json({
    success: true,
    data: sales,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

export const updateStaffPermissions = async (req, res) => {
  const { permissions } = req.body;
  const staff = await User.findOne({ _id: req.params.id, role: 'staff', shop: req.user.shop._id });
  if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });

  staff.permissions = withImpliedPermissions(permissions);
  await staff.save();
  res.json({ success: true, data: staff.permissions });
};