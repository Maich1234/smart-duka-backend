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
  // Not required for a Google-only owner (see googleId below) — an account
  // must have a password, a linked OAuth provider, or both, never neither.
  password: {
    type: String,
    required: [function () { return !this.googleId; }, 'Password is required'],
    minlength: 6,
  },
  role: {
    type: String,
    enum: ['owner', 'staff'],
    default: 'staff',
  },
  // Google's stable subject id ("sub"). Sparse + unique so it's only ever
  // set on accounts that have linked Google, and no two accounts can claim
  // the same Google identity. Never trust anything else from the OAuth
  // claims (name/email changes, role, etc.) — this id is the only thing
  // that's actually stable.
  googleId: {
    type: String,
    unique: true,
    sparse: true,
    index: true,
  },
  // Which credentials can authenticate this account. A password account
  // that later links Google keeps 'password' and gains 'google'; a
  // Google-only signup starts as just ['google'].
  authProviders: {
    type: [String],
    enum: ['password', 'google'],
    default: ['password'],
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
  // Whether this staff member earns commission on the lines they sell. Shops
  // commonly put only part of the floor on commission (sales staff yes, the
  // cashier or stockkeeper no), so eligibility is per-person rather than a
  // shop-wide rule.
  //
  // Defaults to false so switching commission on for a product never silently
  // starts paying the entire team — the owner opts each person in. Owners are
  // exempt from the check entirely: they take the whole margin regardless.
  commissionEligible: {
    type: Boolean,
    default: false,
  },
  fcmTokens: {
    type: [String],
    default: [],
  },
  // This staff member's own shareable referral code — generated once (at
  // createStaff, or lazily on first GET /shop/referrals/me for accounts that
  // predate this feature) so staff can refer new shop owners for a cash
  // bonus, separately from the owner's own Shop.myReferralCode. Owners never
  // get one here.
  myReferralCode: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    uppercase: true,
    maxlength: 10,
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
  // Google-only accounts have no password hash to compare against — treat
  // that as "doesn't match" rather than letting bcrypt.compare throw on
  // undefined, so password login on such an account fails the normal way.
  if (!this.password) return false;
  return await bcrypt.compare(candidatePassword, this.password);
};

userSchema.virtual('sales', {
  ref: 'Sale',
  localField: '_id',
  foreignField: 'staff',
});

export default mongoose.model('User', userSchema);