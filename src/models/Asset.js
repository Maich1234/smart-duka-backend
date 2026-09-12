import mongoose from 'mongoose';

/**
 * Something the business OWNS AND USES to trade — a fridge, a display cabinet,
 * a weighing scale — as distinct from the three things it is constantly
 * confused with:
 *
 *   • Inventory  — goods bought to resell. Lives on Product, valued at cost.
 *   • Expenses   — money spent operating (rent, power). Lives on Expense.
 *   • Liabilities— money owed (supplier credit). Not modelled yet.
 *
 * Nothing creates an Asset automatically. A purchase is a stock movement, an
 * electricity bill is an expense, and neither becomes an asset because it was
 * expensive — the owner decides, explicitly, that a thing belongs here. That
 * is the whole reason this is a separate collection with a manual entry flow
 * rather than a flag on Purchase.
 *
 * Deliberately NOT an accounting fixed-asset register: no depreciation
 * schedule, no useful life, no disposal gain/loss. `currentValue` is the
 * owner's own estimate of what the thing is worth today, entered by hand,
 * and everything downstream is labelled "estimated" because of it.
 */

const ASSET_CATEGORIES = [
  'equipment', 'furniture', 'electronics', 'refrigeration',
  'fixtures', 'transport', 'other',
];

// 'disposed' is kept rather than archived: the owner sold or scrapped the
// thing and wants the record, but it must stop counting toward capital.
const ASSET_STATUSES = ['active', 'in_repair', 'disposed'];

const assetSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: [true, 'Asset name is required'],
    trim: true,
    maxlength: 120,
  },
  category: {
    type: String,
    enum: ASSET_CATEGORIES,
    default: 'other',
  },
  // What the owner paid, PER UNIT. Per-unit rather than per-line so "4 display
  // shelves at 4,500" reads the same whether they were bought together or one
  // at a time, and so editing the count never silently rewrites the price.
  acquisitionValue: {
    type: Number,
    required: [true, 'Purchase value is required'],
    min: 0,
  },
  // The owner's estimate of what one unit is worth NOW. null means they
  // haven't said — the value shown then falls back to acquisitionValue and is
  // labelled as such. 0 is a real answer ("worthless now") and is not null.
  currentValue: {
    type: Number,
    default: null,
    min: 0,
  },
  acquisitionDate: {
    type: Date,
    default: Date.now,
  },
  quantity: {
    type: Number,
    default: 1,
    min: 1,
  },
  serialNumber: { type: String, trim: true, maxlength: 60 },
  notes: { type: String, trim: true, maxlength: 500 },
  imageUrl: { type: String, trim: true },
  status: {
    type: String,
    enum: ASSET_STATUSES,
    default: 'active',
  },
  // Soft removal. Assets feed a figure the owner may have shown a lender, so
  // a mistyped entry is hidden, never erased — there is no DELETE route.
  archivedAt: {
    type: Date,
    default: null,
  },
  recordedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, {
  timestamps: true,
});

// Hot path: "this shop's live assets, newest first" — the list and the
// capital roll-up both filter on archivedAt first.
assetSchema.index({ shop: 1, archivedAt: 1, createdAt: -1 });

/**
 * What one unit is worth today, and which number that came from. Shared by
 * the list endpoint and the capital roll-up so a row's value can never
 * disagree with the total it contributes to.
 */
export const assetUnitValue = (asset) =>
  (asset?.currentValue ?? null) === null
    ? { value: asset?.acquisitionValue ?? 0, basis: 'acquisition' }
    : { value: asset.currentValue, basis: 'current' };

/**
 * The assets that count as owned today: archived rows are hidden mistakes,
 * disposed ones were sold or scrapped. Shared so the list endpoint and the
 * capital roll-up can never disagree about which rows are live.
 */
export const LIVE_ASSET_MATCH = { archivedAt: null, status: { $ne: 'disposed' } };

export const ASSET_CATEGORY_VALUES = ASSET_CATEGORIES;
export const ASSET_STATUS_VALUES = ASSET_STATUSES;
export default mongoose.model('Asset', assetSchema);
