import mongoose from 'mongoose';

// Provider-agnostic payment configuration per shop.
// Each provider sub-document stores its own settings; adding a new provider
// (Stripe, Airtel Money, etc.) is a schema extension, not a refactor.
const mpesaConfigSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  environment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },
  businessName: { type: String, trim: true },
  shortcode: { type: String, trim: true },
  // AES-256-GCM encrypted blobs: "iv:authTag:ciphertext" (all base64-encoded).
  // Decryption only happens server-side during live API calls; never returned to clients.
  consumerKey: { type: String },
  consumerSecret: { type: String },
  passkey: { type: String },
  // Refund (Transaction Reversal) credentials — optional; refunds to M-Pesa
  // stay disabled until both are set. initiatorName is the API operator
  // username from the Daraja portal; securityCredential is the RSA-encrypted
  // initiator password generated on the portal (stored AES-encrypted like the
  // other secrets, decrypted only when a reversal request is sent).
  initiatorName: { type: String, trim: true },
  securityCredential: { type: String },
  configuredAt: { type: Date },
  configuredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { _id: false });

const paymentConfigSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    unique: true,
    index: true,
  },
  mpesa: { type: mpesaConfigSchema, default: () => ({}) },
  // Future providers — add sub-documents here:
  // stripe: { type: stripeConfigSchema, default: () => ({}) },
  // airtelMoney: { type: airtelMoneyConfigSchema, default: () => ({}) },
}, { timestamps: true });

export default mongoose.model('PaymentConfig', paymentConfigSchema);
