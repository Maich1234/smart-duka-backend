import mongoose from 'mongoose';

/**
 * A staff work session at the till. Started explicitly before selling (when
 * the shop has shift management enabled) and ended with a cash reconciliation.
 * The `summary` block is a denormalized snapshot computed at close time so
 * shift reports stay stable even if sales are voided/refunded afterwards —
 * the live truth remains derivable from Sales linked via `Sale.shift`.
 */
const shiftSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  staff: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  status: {
    type: String,
    enum: ['active', 'closed'],
    default: 'active',
  },
  startedAt: {
    type: Date,
    default: Date.now,
  },
  endedAt: {
    type: Date,
  },
  // Who closed it — normally the staff member, but owners can force-close a
  // shift someone forgot to end.
  endedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  // Captured from the client at start for auditing which device ran the till.
  device: {
    platform: { type: String, trim: true, maxlength: 40 },
    name: { type: String, trim: true, maxlength: 80 },
    appVersion: { type: String, trim: true, maxlength: 20 },
  },
  /** Cash in the drawer when the shift began. */
  openingFloat: {
    type: Number,
    default: 0,
    min: 0,
  },
  /** Cash physically counted in the drawer at close. */
  closingCount: {
    type: Number,
    min: 0,
  },
  openingNote: { type: String, trim: true, maxlength: 300 },
  closingNote: { type: String, trim: true, maxlength: 300 },
  // Reconciliation snapshot, written once at close.
  summary: {
    salesCount: { type: Number },
    grossSales: { type: Number },
    discounts: { type: Number },
    byMethod: {
      cash: { count: Number, total: Number },
      mpesa: { count: Number, total: Number },
      card: { count: Number, total: Number },
    },
    refunds: { count: Number, total: Number, cashTotal: Number },
    voids: { count: Number, total: Number },
    cashExpenses: { count: Number, total: Number },
    stockAdjustments: { type: Number },
    /** openingFloat + cash sales − cash refunds − cash expenses. */
    expectedCash: { type: Number },
    /** closingCount − expectedCash (negative = drawer short). */
    cashDiscrepancy: { type: Number },
    durationMinutes: { type: Number },
  },
}, {
  timestamps: true,
});

// One active shift per staff member — enforced at the storage layer so two
// concurrent start requests can't both slip through the application check.
shiftSchema.index(
  { staff: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);
// Shift lists: shop-scoped, newest first, filterable by staff.
shiftSchema.index({ shop: 1, startedAt: -1 });
shiftSchema.index({ shop: 1, staff: 1, startedAt: -1 });

export default mongoose.model('Shift', shiftSchema);
