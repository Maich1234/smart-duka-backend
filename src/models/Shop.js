import mongoose from 'mongoose';

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
}, { timestamps: true });

export default mongoose.model('Shop', shopSchema);