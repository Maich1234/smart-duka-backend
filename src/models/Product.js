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
}, {
  timestamps: true,
});

productSchema.index({ name: 'text', category: 'text', shop: 1 });

export default mongoose.model('Product', productSchema);