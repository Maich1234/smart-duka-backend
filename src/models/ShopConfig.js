import mongoose from 'mongoose';

const shopConfigSchema = new mongoose.Schema(
  {
    shopName: {
      type: String,
      required: true,
      default: 'Smart Duka',
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
  },
  {
    timestamps: true,
  }
);

const ShopConfig = mongoose.model('ShopConfig', shopConfigSchema);
export default ShopConfig;