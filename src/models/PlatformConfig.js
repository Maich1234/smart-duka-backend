import mongoose from 'mongoose';

// Dukana's own (company-level) configuration — a singleton document.
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

// Dukana's own Paystack account — card/bank subscription payments, same
// "never a shop's own account" rule as platformMpesaSchema. publicKey isn't
// sensitive (it's handed to the web client to open the payment popup) and is
// stored plain; secretKey uses the same encrypted-blob scheme as M-Pesa's.
const platformPaystackSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  publicKey: { type: String, trim: true },
  secretKey: { type: String },
  configuredAt: { type: Date },
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
  // Owner-to-owner referral program: a shop that refers another shop banks a
  // stacking discount toward its own next subscription payment once the
  // referred shop actually converts to a paying customer (see
  // subscriptionController.js's applySuccessfulPayment). Admin-tunable
  // rather than hardcoded so the rate/cap can change without a deploy.
  referral: {
    enabled: { type: Boolean, default: false },
    percentPerReferral: { type: Number, default: 20, min: 0, max: 100 },
    maxStackedPercent: { type: Number, default: 100, min: 0, max: 100 },
  },
}, { timestamps: true });

/** Loads the singleton, creating an empty one on first access. */
platformConfigSchema.statics.get = async function get() {
  let doc = await this.findOne({ key: 'platform' });
  if (!doc) doc = await this.create({ key: 'platform' });
  return doc;
};

export default mongoose.model('PlatformConfig', platformConfigSchema);
