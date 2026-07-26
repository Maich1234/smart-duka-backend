import mongoose from 'mongoose';

// SmartDuka's own (company-level) configuration — a singleton document.
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

const platformConfigSchema = new mongoose.Schema({
  // Fixed key makes the singleton enforceable with a unique index.
  key: { type: String, default: 'platform', unique: true },
  mpesa: { type: platformMpesaSchema, default: () => ({}) },
  // Future providers (managed from the super-admin page):
  // card: { ... }, bank: { ... }
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
}, { timestamps: true });

/** Loads the singleton, creating an empty one on first access. */
platformConfigSchema.statics.get = async function get() {
  let doc = await this.findOne({ key: 'platform' });
  if (!doc) doc = await this.create({ key: 'platform' });
  return doc;
};

export default mongoose.model('PlatformConfig', platformConfigSchema);
