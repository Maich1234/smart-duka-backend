import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// SmartDuka's own internal staff — distinct from the shop-tenant User model.
// No `shop` field: admins aren't scoped to a tenant. Accounts are created
// only via scripts/createAdminUser.mjs (no self-serve registration).
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
