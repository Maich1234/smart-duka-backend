import mongoose from 'mongoose';

const supplierSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: [true, 'Supplier name is required'],
    trim: true,
  },
  phone: {
    type: String,
    trim: true,
    default: '',
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    default: '',
  },
  location: {
    type: String,
    trim: true,
    default: '',
  },
  notes: {
    type: String,
    trim: true,
    default: '',
  },
  // Soft-delete flag — suppliers are referenced by historical purchases, so
  // removing one from the picker must never break past purchase records.
  isActive: {
    type: Boolean,
    default: true,
  },
}, {
  timestamps: true,
});

// Hot path: supplier picker/list is always "this shop, alphabetical or newest".
supplierSchema.index({ shop: 1, name: 1 });

export default mongoose.model('Supplier', supplierSchema);
