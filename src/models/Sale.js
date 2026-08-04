import mongoose from 'mongoose';
import { METHOD_KEY_PATTERN } from '../constants/salePaymentMethods.js';
import { nextInvoiceNumber } from '../services/invoiceNumberService.js';

const saleItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  productName: {
    type: String,
    required: true,
  },
  quantity: {
    type: Number,
    required: true,
    // Weighted/refillable items can be sold in fractional amounts (e.g. 0.5 kg);
    // whole-unit enforcement for standard/service/bundle/variable/configurable
    // items happens in pricingEngine.js, not here.
    min: 0.001,
  },
  unitPrice: {
    type: Number,
    required: true,
    min: 0,
  },
  subtotal: {
    type: Number,
    required: true,
  },
  discountAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  appliedPromotionLabel: {
    type: String,
  },
  // Snapshot of the employee commission earned on this line, computed at
  // sale time from the variant's commission config so later config changes
  // never retroactively alter historical earnings.
  commissionAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  // Cost of goods for this line, snapshotted at sale time. Purchasing rewrites
  // Product.costPrice on every landed-cost allocation (weighted average — see
  // purchaseStockService.computeWeightedAverageCost), so reading cost back from
  // the product at report time makes a past period's profit change whenever new
  // stock arrives. Tolerable on a live dashboard tile; disqualifying in a P&L
  // the owner hands to a lender.
  //
  // null means "recorded before this field existed" — books must report such
  // periods as Estimated rather than silently mixing two costing methods.
  // 0 is a real cost (services), and is not the same as null.
  unitCost: {
    type: Number,
    default: null,
    min: 0,
  },
  // quantity × unitCost, stored rather than derived — same reasoning as
  // purchaseItemSchema.totalCost: a historical fact must not drift if rounding
  // rules change later.
  costTotal: {
    type: Number,
    default: null,
    min: 0,
  },
  // True when unitCost was reconstructed after the fact by
  // scripts/backfillSaleCosts.mjs from a later costPrice, rather than captured
  // at sale time. Without this the backfill would erase the very signal books
  // use to tell an exact period from an approximated one — a filled-in cost
  // looks identical to a real snapshot. Books must label any period containing
  // an estimated line as Estimated.
  costEstimated: {
    type: Boolean,
    default: false,
  },
  // Snapshot fields — optional, only populated for the product types that need them.
  variantId: {
    type: mongoose.Schema.Types.ObjectId,
  },
  variantName: {
    type: String,
  },
  unitOfMeasure: {
    type: String,
  },
  productType: {
    type: String,
  },
});

const saleSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  // Unique per shop, not globally — see the compound index below.
  invoiceNumber: {
    type: String,
  },
  items: [saleItemSchema],
  totalAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  // Sum of items[].commissionAmount — denormalized for fast per-staff/period
  // commission aggregation without unwinding items on every query.
  totalCommission: {
    type: Number,
    default: 0,
    min: 0,
  },
  // A key from the shop's own payment-method list (see
  // constants/salePaymentMethods.js). Not an enum any more: shops define their
  // own buttons — Airtel Money, a bank account, a Pochi — and an enum could
  // only ever hold the three Safaricom-shaped guesses this app started with.
  // Membership is enforced in the controller against the shop's config, which
  // is the only place that knows the valid set.
  paymentMethod: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    match: METHOD_KEY_PATTERN,
  },
  // The button's label at the time of sale. Snapshotted so renaming or
  // removing a method later never rewrites what a printed receipt said.
  paymentMethodLabel: {
    type: String,
    trim: true,
  },
  // Populated for M-Pesa sales — links to the confirmed STK Push transaction
  mpesaTransactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MpesaTransaction',
  },
  mpesaReceiptNumber: {
    type: String,
  },
  staff: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  // The work session this sale happened in (set when the seller had an
  // active shift). Optional so shops with shift management off — and all
  // pre-feature sales — keep working unchanged.
  shift: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shift',
  },
  // Voided/refunded sales stay visible in history (with a badge) but are
  // excluded from every revenue/stats aggregate. Both restore the stock the
  // sale deducted — refunds only once the money is actually back with the
  // customer ('refund_pending' still counts as revenue until then).
  status: {
    type: String,
    enum: ['completed', 'voided', 'refund_pending', 'refunded'],
    default: 'completed',
  },
  voidedAt: { type: Date },
  voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  voidReason: { type: String, maxlength: 300 },
  // Refund lifecycle. Cash/card refunds complete immediately (money handed
  // back over the counter); M-Pesa refunds go through Safaricom's async
  // Transaction Reversal API — initiation sets 'refund_pending' and the
  // result callback settles it to 'refunded' or back to 'completed'.
  refund: {
    amount: { type: Number, min: 0 },
    method: { type: String, enum: ['cash', 'mpesa'] },
    reason: { type: String, maxlength: 300 },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    requestedAt: { type: Date },
    completedAt: { type: Date },
    // Safaricom reversal correlation ids — the result callback only carries
    // these, so they're how the callback finds this sale again.
    originatorConversationId: { type: String },
    conversationId: { type: String },
    // Receipt number of the reversal transaction itself (from the result callback)
    reversalTransactionId: { type: String },
    resultCode: { type: String },
    resultDesc: { type: String },
    // Set when a reversal attempt failed — shown in the UI so the cashier
    // knows why and can retry or refund in cash instead.
    failureReason: { type: String },
  },
}, {
  timestamps: true,
});

// Hot paths: shop-scoped date-sorted lists/stats, and per-staff history.
saleSchema.index({ shop: 1, createdAt: -1 });
saleSchema.index({ shop: 1, staff: 1, createdAt: -1 });
// Shift reconciliation aggregates every sale in a shift at close time.
saleSchema.index({ shift: 1 }, { sparse: true });
// Reversal result callbacks look the sale up by Safaricom's correlation id.
saleSchema.index({ 'refund.originatorConversationId': 1 }, { sparse: true });
// Invoice numbers are unique *within a shop*. This replaces a collection-wide
// unique index on invoiceNumber alone, which collided across tenants: the
// number was generated from a per-shop count, so every shop's first sale of a
// given month wanted the same INV-YYMM-00001 and only one could have it.
//
// Existing databases carry the old `invoiceNumber_1` index — it must be dropped
// or it keeps rejecting those sales. See scripts/fixInvoiceNumbering.mjs.
saleSchema.index({ shop: 1, invoiceNumber: 1 }, { unique: true });

// Runs inside the caller's session when there is one — saleController creates
// sales inside withTransaction, and joining that transaction is what lets an
// aborted sale return its number to the pool instead of burning it.
// Sequencing rules and their rationale live in invoiceNumberService.
saleSchema.pre('save', async function (next) {
  if (!this.isNew || this.invoiceNumber) return next();

  try {
    this.invoiceNumber = await nextInvoiceNumber(this.shop, {
      ShopModel: mongoose.model('Shop'),
      session: this.$session(),
    });
    return next();
  } catch (error) {
    return next(error);
  }
});

export default mongoose.model('Sale', saleSchema);