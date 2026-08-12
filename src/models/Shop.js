import mongoose from 'mongoose';
import { DEFAULT_PAYMENT_METHODS, METHOD_KEY_PATTERN } from '../constants/salePaymentMethods.js';

// One button on the till. `key` is what lands on Sale.paymentMethod; `label`
// is what the cashier and the receipt see, and the owner may rename it freely
// (renaming never rewrites history — sales snapshot the label they were made
// under). Disabling instead of deleting keeps old sales readable.
const shopPaymentMethodSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    match: METHOD_KEY_PATTERN,
  },
  label: { type: String, required: true, trim: true, maxlength: 24 },
  icon: { type: String, trim: true, default: 'wallet' },
  enabled: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
}, { _id: false });

const shopSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  address: {
    type: String,
    default: '',
  },
  phone: {
    type: String,
    default: '',
  },
  email: {
    type: String,
    default: '',
  },
  taxRate: {
    type: Number,
    default: 0,
  },
  country: {
    type: String,
    default: 'KE',
    trim: true,
    uppercase: true,
  },
  // Denormalized display names (not refs) from the Location collection —
  // matches how `address` already works, and keeps push-campaign area
  // targeting a plain string match instead of a join.
  county: {
    type: String,
    default: '',
    trim: true,
  },
  subCounty: {
    type: String,
    default: '',
    trim: true,
  },
  currency: {
    type: String,
    default: 'KES',
    trim: true,
    uppercase: true,
  },
  receiptThankYouNote: {
    type: String,
    default: '',
    trim: true,
    maxlength: 150,
  },
  logoUrl: {
    type: String,
    default: '',
    trim: true,
  },
  motto: {
    type: String,
    default: '',
    trim: true,
    maxlength: 200,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  // Owner-controlled feature flag: when on, staff must start a shift before
  // recording sales, shift-close reports are pushed to the owner, and the
  // end-of-day cron compiles a daily business summary for this shop.
  shiftManagementEnabled: {
    type: Boolean,
    default: false,
  },
  // Owner-controlled feature flag: when on, staff can see a live commission
  // preview while making a sale and view their own earned-commission totals.
  // When off, both surfaces stay hidden and product responses omit any
  // commission data for staff.
  showStaffCommission: {
    type: Boolean,
    default: false,
  },
  // Owner-controlled feature flag: when off, the Purchasing module is
  // completely hidden from navigation for every staff member (and the owner).
  purchasingEnabled: {
    type: Boolean,
    default: false,
  },
  // How additional purchase costs (transport, packaging, ...) are spread
  // across a purchase's line items when updating each product's average
  // cost. A shop-wide default (not chosen per purchase) so recording a
  // purchase stays fast — each Purchase snapshots whichever method was
  // active when it was created. 'none' = costs are tracked for reporting but
  // never blended into product cost.
  purchaseCostAllocationMethod: {
    type: String,
    enum: ['quantity', 'value', 'none'],
    default: 'none',
  },
  // Owner-controlled feature flag: when on, Gemini-powered features (Daily
  // Insight, Business Consultant chat, and future procurement intelligence)
  // are available; when off, no business data is sent to Gemini. Independent
  // of subscription tier — a subscriber can still opt out of AI processing.
  aiEnabled: {
    type: Boolean,
    default: true,
  },
  // Owner-controlled kill switch for the till's camera barcode scanner.
  // Defaults on (unlike the other flags above) — scanning has to work with
  // zero setup, so this only exists for an owner who wants to turn it off.
  barcodeScanningEnabled: {
    type: Boolean,
    default: true,
  },
  // The till's payment buttons, owner-managed. Empty/missing means "never
  // touched the setting" and resolves to DEFAULT_PAYMENT_METHODS — read it
  // through resolvePaymentMethods(), never straight off the document, because
  // lean() reads skip schema defaults.
  paymentMethods: {
    type: [shopPaymentMethodSchema],
    default: () => DEFAULT_PAYMENT_METHODS.map((m, i) => ({ ...m, order: i })),
  },
  // Optional code entered at THIS shop's own signup — either an onboarding
  // agent's code (dukana-admin-backend's onboarding flow matches it against
  // an Agent) or another shop's own `myReferralCode` (see below). Captured
  // verbatim, uppercased for case-insensitive matching; this repo never
  // validates it against an Agent, only against other shops (see register.js).
  referredByCode: {
    type: String,
    default: '',
    trim: true,
    uppercase: true,
    maxlength: 40,
  },
  // Which shop referredByCode actually resolved to, if it matched another
  // shop's own code (not an agent's) — the link the referral-discount reward
  // is paid against. Null if referredByCode was empty, an agent's code, or a
  // typo that matched nothing.
  referredByShopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    default: null,
  },
  // This shop's own shareable code — generated once at registration, unique.
  // Someone who signs up with it becomes `referredByShopId` for this shop.
  myReferralCode: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    uppercase: true,
    maxlength: 16,
  },
  // Set once, the first time this shop's referral discount is actually
  // granted to whoever referred it (see applySuccessfulPayment) — prevents a
  // cancel/resubscribe cycle from double-rewarding the referrer, and stops a
  // later re-enable of the feature from retroactively rewarding an old
  // conversion that happened while it was off.
  referralRewardGranted: {
    type: Boolean,
    default: false,
  },
  // Monotonic invoice counter for this shop, bumped atomically by Sale's
  // pre-save hook via $inc.
  //
  // Replaces the old `countDocuments({ shop })` scheme, which was wrong twice
  // over: the count was per-shop but the unique index on Sale.invoiceNumber was
  // collection-wide, so two shops' first sale of a month both produced
  // INV-YYMM-00001 and the second one failed outright; and the read raced with
  // itself, so two concurrent sales in one shop saw the same count.
  //
  // Seeded for existing shops by scripts/fixInvoiceNumbering.mjs.
  invoiceSeq: {
    type: Number,
    default: 0,
    min: 0,
  },
}, { timestamps: true });

export default mongoose.model('Shop', shopSchema);