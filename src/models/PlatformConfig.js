import mongoose from 'mongoose';

// DuQana's own (company-level) configuration — a singleton document.
// Subscription payments are collected with these Daraja credentials, never a
// shop's own PaymentConfig. Will be managed from the super-admin page;
// seeded once via scripts/seedPlatformConfig.mjs.
const platformMpesaSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  environment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },
  businessName: { type: String, trim: true },
  shortcode: { type: String, trim: true },
  // AES-256-GCM encrypted blobs ("iv:authTag:ciphertext"), same scheme as
  // PaymentConfig — decrypted only inside mpesaService during live API calls.
  consumerKey: { type: String },
  consumerSecret: { type: String },
  passkey: { type: String },
  configuredAt: { type: Date },
}, { _id: false });

// DuQana's own Paystack account — card/bank subscription payments, same
// "never a shop's own account" rule as platformMpesaSchema. publicKey isn't
// sensitive (it's handed to the web client to open the payment popup) and is
// stored plain; secretKey uses the same encrypted-blob scheme as M-Pesa's.
const platformPaystackSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  publicKey: { type: String, trim: true },
  secretKey: { type: String },
  configuredAt: { type: Date },
}, { _id: false });

// Shared by all three referral audiences below: whether the program is live
// at all, and an optional time-box. Both PATCH-able independently per
// audience from the admin Referrals tab.
const referralAudienceBaseFields = {
  enabled: { type: Boolean, default: false },
  startsAt: { type: Date, default: null },
  endsAt: { type: Date, default: null },
};

// Owner-to-owner referral program: a shop that refers another shop banks a
// stacking discount toward its own next subscription payment once the
// referred shop actually converts to a paying customer (see
// subscriptionController.js's rewardReferrerIfFirstConversion).
const shopOwnerReferralSchema = new mongoose.Schema({
  ...referralAudienceBaseFields,
  percentPerReferral: { type: Number, default: 20, min: 0, max: 100 },
  maxStackedPercent: { type: Number, default: 100, min: 0, max: 100 },
}, { _id: false });

// Staff referral program: a fixed KES cash bonus, tracked in
// EmployeeReferralPayout and settled manually by a platform admin — never a
// subscription-credit like the shop-owner program above.
const employeeReferralSchema = new mongoose.Schema({
  ...referralAudienceBaseFields,
  cashAmount: { type: Number, default: 0, min: 0 },
}, { _id: false });

// Agent referral program: deliberately no reward field here. An agent's
// payout stays entirely on the existing CommissionRule/CommissionRecord
// machinery in dukana-admin-backend — this toggle only gates whether an
// agent-code redemption at shop signup is allowed to auto-link an
// Onboarding row (see agentReferralLinkService.js there).
const agentReferralSchema = new mongoose.Schema({
  ...referralAudienceBaseFields,
}, { _id: false });

const platformConfigSchema = new mongoose.Schema({
  // Fixed key makes the singleton enforceable with a unique index.
  key: { type: String, default: 'platform', unique: true },
  mpesa: { type: platformMpesaSchema, default: () => ({}) },
  paystack: { type: platformPaystackSchema, default: () => ({}) },
  // When on, staffController.createStaff tells the web client to prompt an
  // immediate top-up payment for a newly-added seat's prorated cost instead
  // of only letting it ride silently to the next invoice. Off by default —
  // this is a nudge shown on web only (mobile has no payment UI at all, see
  // subscription.tsx's own comment on why), never a hard gate: staff
  // creation itself is never blocked on payment either way.
  immediateSeatBilling: { type: Boolean, default: false },
  // Days of continued access after trial/period expiry before the owner is
  // sent to the paywall.
  gracePeriodDays: { type: Number, default: 3, min: 0 },
  // Extra days, on top of gracePeriodDays, during which *staff* can still
  // record sales after the owner has been locked out.
  //
  // A duka that cannot take money churns; a duka that cannot see its
  // analytics renews. So the till is the last thing to stop working, not the
  // first — the owner hits the paywall on day 0 and the shop keeps trading
  // while they find the money.
  staffGraceExtraDays: { type: Number, default: 7, min: 0 },
  // How many days before expiry to push renewal reminders.
  reminderDaysBefore: { type: [Number], default: [7, 3] },
  // Three independent referral programs — shop owners, employees, and
  // agents each have their own enable switch, date window, and reward shape.
  // Admin-tunable rather than hardcoded so each can change without a deploy.
  referral: {
    shopOwner: { type: shopOwnerReferralSchema, default: () => ({}) },
    employee: { type: employeeReferralSchema, default: () => ({}) },
    agent: { type: agentReferralSchema, default: () => ({}) },
  },
}, { timestamps: true });

/** Loads the singleton, creating an empty one on first access. */
platformConfigSchema.statics.get = async function get() {
  let doc = await this.findOne({ key: 'platform' });
  if (!doc) doc = await this.create({ key: 'platform' });
  return doc;
};

export default mongoose.model('PlatformConfig', platformConfigSchema);
