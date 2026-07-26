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
  isEmailVerified: {
    type: Boolean,
    default: false,
  },
  phone: {
    type: String,
    trim: true,
  },
  permissions: {
    type: [String],
    default: DEFAULT_STAFF_PERMISSIONS,
  },
  fcmTokens: {
    type: [String],
    default: [],
  },
  // Proof of consent to the Terms of Service and Privacy Policy: which
  // version, and when. Recorded at registration from the signup checkbox.
  //
  // Staff accounts are created by their shop owner rather than signing
  // themselves up, so these stay null for them — the owner accepted on behalf
  // of the business, which is what the terms themselves say.
  termsAcceptedAt: { type: Date, default: null },
  termsVersion: { type: String, default: null },
  // Account closure is a scheduled soft delete, not an immediate purge.
  //
  // Deletion is irreversible and, for an owner, destroys a whole business
  // and every staff account with it — so it gets a cooling-off window. The
  // account keeps working normally throughout, shows a persistent banner, and
  // can be restored with one tap. A cron purges anything past its date.
  // (Play's deletion requirement is satisfied by an initiated deletion with a
  // stated completion date; a recovery window is expressly allowed.)
  deletionScheduledAt: { type: Date, default: null, index: true },
  deletionRequestedAt: { type: Date, default: null },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const rounds = parseInt(process.env.BCRYPT_ROUNDS) || 10;
  this.password = await bcrypt.hash(this.password, rounds);
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