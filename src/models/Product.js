import mongoose from 'mongoose';

// Employee commission config. `basePrice` is the shop's floor for one unit;
// whatever the line actually earns above that floor is split with the seller by
// `employeeSharePercent` (the remainder stays with the shop on top of the floor).
//
// Declared once and reused at both product level and variant level: a variant's
// config overrides its parent product's when the variant enables one, which is
// what lets a shop set a default for a product and tune a single size/flavour.
//
// `basePrice` is as margin-revealing as `costPrice` and must never be sent to a
// staff role — see `sanitizeForStaff` in controllers/productController.js.
const commissionConfig = () => ({
  enabled: { type: Boolean, default: false },
  basePrice: { type: Number, min: 0 },
  employeeSharePercent: { type: Number, min: 0, max: 100, default: 100 },
});

const productSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: [true, 'Product name is required'],
    trim: true,
  },
  description: {
    type: String,
    trim: true,
  },
  category: {
    type: String,
    required: [true, 'Category is required'],
    trim: true,
    lowercase: true,
  },
  sku: {
    type: String,
    trim: true,
  },
  barcode: {
    type: String,
    trim: true,
  },
  sellingPrice: {
    type: Number,
    required: [true, 'Selling price is required'],
    min: 0,
  },
  costPrice: {
    type: Number,
    required: [true, 'Cost price is required'],
    min: 0,
  },
  // No `min: 0` — a sale is allowed to take this below zero (stock physically
  // in the shop but not yet purchased into the system); saleController.js
  // alerts the owner whenever that happens. See pricingEngine.js.
  quantity: {
    type: Number,
    required: true,
    default: 0,
  },
  lowStockAlert: {
    type: Number,
    default: 5,
    min: 0,
  },
  productType: {
    type: String,
    enum: ['standard', 'variable', 'weighted', 'refillable', 'service', 'bundle', 'configurable'],
    default: 'standard',
  },
  trackInventory: {
    type: Boolean,
    default: true,
  },
  unitOfMeasure: {
    type: String,
    enum: ['unit', 'kg', 'g', 'l', 'ml', 'dozen', 'pack', 'box', 'bag', 'lb', 'oz', 'm', 'cm', 'ton'],
    default: 'unit',
  },
  minPrice: {
    type: Number,
    min: 0,
  },
  maxPrice: {
    type: Number,
    min: 0,
  },
  allowPriceOverride: {
    type: Boolean,
    default: false,
  },
  // Product-level commission, honoured by every product type. Commission used
  // to exist only on `configurable` variants, which meant the ordinary shop —
  // one selling standard products — could switch "show commission to staff" on
  // and still never generate a single shilling of it.
  commission: commissionConfig(),
  bundleItems: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    quantity: { type: Number, min: 0.001 },
  }],
  promotions: [{
    label: { type: String, trim: true },
    buyQty: { type: Number, required: true, min: 1 },
    freeQty: { type: Number, required: true, min: 1 },
    isActive: { type: Boolean, default: true },
  }],
  variants: [{
    name: { type: String, required: true, trim: true },
    sellingPrice: { type: Number, required: true, min: 0 },
    costPrice: { type: Number, required: true, min: 0 },
    // No `min: 0` — same reasoning as the top-level `quantity` field above.
    quantity: { type: Number, default: 0 },
    sku: { type: String, trim: true },
    barcode: { type: String, trim: true },
    lowStockAlert: { type: Number, default: 5, min: 0 },
    // Overrides the parent product's commission when this variant enables one.
    commission: commissionConfig(),
  }],
}, {
  timestamps: true,
});

productSchema.index({ name: 'text', category: 'text', shop: 1 });
// Hot path: the inventory/POS list is always "this shop, newest first".
productSchema.index({ shop: 1, createdAt: -1 });
// A shop can't have two products with the identical name, but different
// shops are fully independent — this must stay scoped to `shop`. (Replaces a
// stray global `name_1` unique index that existed directly on the production
// database with no `shop` scoping and no matching schema declaration; that
// index blocked every shop on the platform from reusing a product name any
// other shop had already used, e.g. "Water refill".)
productSchema.index({ shop: 1, name: 1 }, { unique: true });
// Not unique on purpose: MongoDB partial indexes only support a narrow,
// documented operator set for their filter expression (no $ne), so reliably
// excluding both "missing" and "" from a uniqueness check needs machinery
// (explicit $unset-to-clear semantics, etc.) this feature doesn't need — a
// scan only has to be fast, not globally exclusive. A data-entry duplicate
// just resolves to the first match.
productSchema.index({ shop: 1, barcode: 1 });

export default mongoose.model('Product', productSchema);