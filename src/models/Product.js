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
    enum: ['unit', 'kg', 'g', 'l', 'ml'],
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
  variants: [{
    name: { type: String, required: true, trim: true },
    sellingPrice: { type: Number, required: true, min: 0 },
    costPrice: { type: Number, required: true, min: 0 },
    quantity: { type: Number, default: 0, min: 0 },
    sku: { type: String, trim: true },
    lowStockAlert: { type: Number, default: 5, min: 0 },
  }],
}, {
  timestamps: true,
});

productSchema.index({ name: 'text', category: 'text', shop: 1 });

export default mongoose.model('Product', productSchema);