import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { ADMIN_PERMISSION_VALUES } from '../constants/adminPermissions.js';

// Dukana's own internal staff — distinct from the shop-tenant User model.
// No `shop` field: admins aren't scoped to a tenant. Most accounts are
// created via the admin-management API (super_admin only, see
// adminManagementController.js); scripts/createAdminUser.mjs remains as a
// break-glass bootstrap path independent of the API/DB app layer.
const adminUserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 6,
  },
  active: {
    type: Boolean,
    default: true,
  },
  // super_admin implicitly has full access everywhere — `permissions` is
  // only consulted (via requirePermission) for role === 'admin'.
  role: {
    type: String,
    enum: ['super_admin', 'admin'],
    default: 'admin',
  },
  permissions: {
    type: [String],
    enum: ADMIN_PERMISSION_VALUES,
    default: [],
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AdminUser',
    default: null,
  },
}, {
  timestamps: true,
});

adminUserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const rounds = parseInt(process.env.BCRYPT_ROUNDS) || 10;
  this.password = await bcrypt.hash(this.password, rounds);
  next();
});

adminUserSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

export default mongoose.model('AdminUser', adminUserSchema);
