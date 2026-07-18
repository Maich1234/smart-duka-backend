import User from '../models/User.js';
import Subscription from '../models/Subscription.js';
import RefreshToken from '../models/RefreshToken.js';
import { DEFAULT_STAFF_PERMISSIONS, withImpliedPermissions } from '../constants/permissions.js';
import { parsePagination } from '../utils/pagination.js';
import { escapeRegex } from '../utils/escapeRegex.js';
import { getBillableUserCount, computeSeatAdditionImpact } from '../services/subscriptionPricingService.js';
import { resolveStaffEmailSlot } from './seatPaymentController.js';
import { revokeAllSessions } from '../services/refreshTokenService.js';
import { logAudit } from '../services/auditLogService.js';
import { sendPushToUser } from '../utils/push.js';
import { isSystemGeneratedEmail } from '../utils/staffEmailSlug.js';
import { sendVerificationEmail } from '../utils/emailVerification.js';

/**
 * Login guarantees at most one unrevoked+unexpired RefreshToken per staff
 * user, so this is a flat lookup with no "latest per user" grouping needed.
 */
const attachActiveSessions = async (staffList) => {
  const ids = staffList.map((s) => s._id);
  const sessions = await RefreshToken.find({ user: { $in: ids }, revokedAt: null, expiresAt: { $gt: new Date() } });
  const byUser = new Map(sessions.map((s) => [String(s.user), s]));
  return staffList.map((staff) => {
    const session = byUser.get(String(staff._id));
    const obj = staff.toObject ? staff.toObject() : staff;
    obj.activeSession = session
      ? { deviceName: session.deviceName, platform: session.platform, lastActiveAt: session.createdAt }
      : null;
    return obj;
  });
};

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
    data: await attachActiveSessions(staff),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

export const getStaffById = async (req, res) => {
  const staff = await User.findOne({ _id: req.params.id, role: 'staff', shop: req.user.shop._id }).select('-password');
  if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });
  const [withSession] = await attachActiveSessions([staff]);
  res.json({ success: true, data: withSession });
};

export const createStaff = async (req, res) => {
  const { email } = req.body;
  try {
    await resolveStaffEmailSlot(email);
  } catch (err) {
    return res.status(err.status ?? 500).json({ success: false, code: err.code, message: err.message });
  }

  const shopId = req.user.shop._id;
  const subscription = await Subscription.findOne({ shop: shopId }).populate('plan').lean();
  if (subscription?.plan) {
    const currentStaffCount = await getBillableUserCount(shopId);
    const impact = computeSeatAdditionImpact(subscription.plan, currentStaffCount, subscription.billingCycle);
    if (impact.increased) {
      // Activating this seat costs money — the client must go through
      // POST /staff/seat-payment (M-Pesa STK push) instead of creating the
      // staff row directly. See seatPaymentController.js.
      return res.status(409).json({
        success: false,
        code: 'SEAT_PAYMENT_REQUIRED',
        message: `Adding this team member raises your ${subscription.billingCycle} bill from ${impact.currentAmount} to ${impact.projectedAmount} ${subscription.plan.currency}. Payment is required to continue.`,
        data: {
          currentAmount: impact.currentAmount,
          projectedAmount: impact.projectedAmount,
          currency: subscription.plan.currency,
          billingCycle: subscription.billingCycle,
        },
      });
    }
  }

  const isEmailVerified = isSystemGeneratedEmail(email, req.user.shop.name);
  const staff = await User.create({
    ...req.body,
    role: 'staff',
    shop: req.user.shop._id,
    isActive: true,
    isEmailVerified,
    permissions: withImpliedPermissions(req.body.permissions ?? DEFAULT_STAFF_PERMISSIONS),
  });

  if (!isEmailVerified) {
    sendVerificationEmail(staff).catch((err) => console.error('[createStaff] verification email failed:', err.message));
  }

  const staffResponse = staff.toObject();
  delete staffResponse.password;
  res.status(201).json({ success: true, data: staffResponse });
};

export const checkStaffEmailAvailability = async (req, res) => {
  const email = String(req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ success: false, message: 'email is required' });

  const exists = await User.exists({ email });
  res.json({ success: true, data: { available: !exists } });
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

  await revokeAllSessions(staff._id, 'password_change');
  await logAudit({
    shopId: req.user.shop._id,
    userId: staff._id,
    action: 'auth.password_change',
    entityType: 'RefreshToken',
    details: { performedBy: req.user._id },
    req,
  });

  res.json({ success: true, message: 'Password reset successfully' });
};

export const forceLogoutStaff = async (req, res) => {
  const staff = await User.findOne({ _id: req.params.id, role: 'staff', shop: req.user.shop._id });
  if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });

  const activeSession = await RefreshToken.findOne({ user: staff._id, revokedAt: null, expiresAt: { $gt: new Date() } });
  await revokeAllSessions(staff._id, 'admin_force_logout');
  await logAudit({
    shopId: req.user.shop._id,
    userId: staff._id,
    action: 'auth.force_logout',
    entityType: 'RefreshToken',
    details: { performedBy: req.user._id },
    req,
  });

  if (activeSession) {
    await sendPushToUser(staff, {
      title: 'Signed out',
      body: 'You were signed out by your shop owner.',
      data: { type: 'force_logout', deviceId: activeSession.deviceId },
    }).catch((err) => console.error('[forceLogoutStaff] push failed', err.message));
  }

  res.json({ success: true, message: 'Staff member signed out' });
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

export const getStaffCommission = async (req, res) => {
  const staff = await User.findOne({ _id: req.params.id, role: 'staff', shop: req.user.shop._id });
  if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });

  const { getCommissionSummary } = await import('../services/commissionService.js');
  const { startDate, endDate } = req.query;
  const summary = await getCommissionSummary(req.user.shop._id, staff._id, { startDate, endDate });
  res.json({ success: true, data: summary });
};

export const updateStaffPermissions = async (req, res) => {
  const { permissions } = req.body;
  const staff = await User.findOne({ _id: req.params.id, role: 'staff', shop: req.user.shop._id });
  if (!staff) return res.status(404).json({ success: false, message: 'Staff not found' });

  staff.permissions = withImpliedPermissions(permissions);
  await staff.save();
  res.json({ success: true, data: staff.permissions });
};