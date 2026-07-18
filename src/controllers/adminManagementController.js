import AdminUser from '../models/AdminUser.js';
import { parsePagination } from '../utils/pagination.js';

/** GET /admin/admins */
export const listAdmins = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const [admins, total] = await Promise.all([
    AdminUser.find().select('-password').sort({ createdAt: -1 }).skip(skip).limit(limit),
    AdminUser.countDocuments(),
  ]);
  res.json({ success: true, data: admins, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};

/** POST /admin/admins */
export const createAdmin = async (req, res) => {
  try {
    const admin = await AdminUser.create({ ...req.body, createdBy: req.admin._id });
    const response = admin.toObject();
    delete response.password;
    res.status(201).json({ success: true, data: response });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: `An admin with email "${req.body.email}" already exists.` });
    }
    throw err;
  }
};

/**
 * PATCH /admin/admins/:id
 * Uses findById + mutate + save (never findByIdAndUpdate) so the
 * pre('save') password-hash hook fires when a new password is sent —
 * same pattern as staffController.updateStaff.
 */
export const updateAdmin = async (req, res) => {
  const admin = await AdminUser.findById(req.params.id);
  if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });

  const { name, email, password, role, permissions, active } = req.body;

  const demotingOrDeactivatingSuperAdmin =
    admin.role === 'super_admin' &&
    ((role !== undefined && role !== 'super_admin') || active === false);

  if (demotingOrDeactivatingSuperAdmin) {
    const otherActiveSuperAdmins = await AdminUser.countDocuments({
      role: 'super_admin',
      active: true,
      _id: { $ne: admin._id },
    });
    if (otherActiveSuperAdmins === 0) {
      return res.status(409).json({ success: false, message: 'Cannot demote or deactivate the last active super admin.' });
    }
  }

  if (name !== undefined) admin.name = name;
  if (email !== undefined) admin.email = email;
  if (password !== undefined) admin.password = password;
  if (role !== undefined) admin.role = role;
  if (permissions !== undefined) admin.permissions = permissions;
  if (active !== undefined) admin.active = active;

  try {
    await admin.save();
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: `An admin with email "${email}" already exists.` });
    }
    throw err;
  }

  const response = admin.toObject();
  delete response.password;
  res.json({ success: true, data: response });
};

/** DELETE /admin/admins/:id */
export const deleteAdmin = async (req, res) => {
  if (String(req.params.id) === String(req.admin._id)) {
    return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
  }

  const admin = await AdminUser.findById(req.params.id);
  if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });

  if (admin.role === 'super_admin') {
    // Not filtered by `active` — deleting the only super_admin row is
    // unrecoverable even if it's currently deactivated (unlike demotion,
    // which a still-existing deactivated super_admin could be reversed from).
    const otherSuperAdmins = await AdminUser.countDocuments({ role: 'super_admin', _id: { $ne: admin._id } });
    if (otherSuperAdmins === 0) {
      return res.status(409).json({ success: false, message: 'Cannot delete the last super admin.' });
    }
  }

  await admin.deleteOne();
  res.json({ success: true, message: 'Admin deleted' });
};
