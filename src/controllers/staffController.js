import User from '../models/User.js';
import { DEFAULT_STAFF_PERMISSIONS } from '../constants/permissions.js';

export const getStaff = async (req, res) => {
  const { page = 1, limit = 10, search, startDate, endDate } = req.query;
  const query = { role: 'staff', shop: req.user.shop._id };
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
  }
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }
  const limitN = Math.min(parseInt(limit), 100);
  const skip = (parseInt(page) - 1) * limitN;
  const [staff, total] = await Promise.all([
    User.find(query).select('-password').sort({ createdAt: -1 }).skip(skip).limit(limitN),
    User.countDocuments(query),
  ]);
  res.json({
    success: true,
    data: staff,
    pagination: { page: parseInt(page), limit: limitN, total, pages: Math.ceil(total / limitN) },
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
    permissions: DEFAULT_STAFF_PERMISSIONS,
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
  if (permissions) staff.permissions = permissions;

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

  const { page = 1, limit = 20, startDate, endDate } = req.query;
  const query = { staff: staff._id, shop: req.user.shop._id };
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sales = await Sale.find(query).skip(skip).limit(parseInt(limit)).sort({ createdAt: -1 });
  const total = await Sale.countDocuments(query);

  res.json({
    success: true,
    data: sales,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
  });
};

export const updateStaffPermissions = async (req, res) => {
  const { permissions } = req.body;
  const staff = await User.findOne({ _id: req.params.id, role: 'staff', shop: req.user.shop._id });
  if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });

  staff.permissions = permissions;
  await staff.save();
  res.json({ success: true, data: staff.permissions });
};