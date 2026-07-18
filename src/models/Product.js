import mongoose from 'mongoose';

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
  quantity: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
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
    quantity: { type: Number, default: 0, min: 0 },
    sku: { type: String, trim: true },
    lowStockAlert: { type: Number, default: 5, min: 0 },
    // Employee commission: `basePrice` is the shop's floor for this variant;
    // anything the variant sells for above it is split with the seller by
    // `employeeSharePercent` (the rest stays with the shop on top of basePrice).
    commission: {
      enabled: { type: Boolean, default: false },
      basePrice: { type: Number, min: 0 },
      employeeSharePercent: { type: Number, min: 0, max: 100, default: 100 },
    },
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

export default mongoose.model('Product', productSchema);