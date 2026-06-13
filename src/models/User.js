import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { DEFAULT_STAFF_PERMISSIONS, ALL_PERMISSIONS } from '../constants/permissions.js';

const userSchema = new mongoose.Schema({
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
  role: {
    type: String,
    enum: ['owner', 'staff'],
    default: 'staff',
  },
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  phone: {
    type: String,
    trim: true,
  },
  permissions: {
    type: [String],
    default: DEFAULT_STAFF_PERMISSIONS,
  },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, parseInt(process.env.BCRYPT_ROUNDS));
  next();
});

userSchema.pre('save', function(next) {
  if (this.role === 'owner') {
    this.permissions = ALL_PERMISSIONS.map(p => p.value);
  }
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

userSchema.virtual('sales', {
  ref: 'Sale',
  localField: '_id',
  foreignField: 'staff',
});

export default mongoose.model('User', userSchema);