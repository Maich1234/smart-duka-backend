import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productName: String,
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actorName: { type: String, default: null },
  source: { type: String, enum: ['created', 'product_edit', 'purchase'], required: true },
  reference: mongoose.Schema.Types.ObjectId,
  changes: [{ key: String, before: mongoose.Schema.Types.Mixed, after: mongoose.Schema.Types.Mixed }],
}, { timestamps: true, versionKey: false });
schema.index({ shop: 1, product: 1, createdAt: -1 });
export default mongoose.model('ProductPriceChange', schema);
