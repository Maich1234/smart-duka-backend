import mongoose from 'mongoose';
const schema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, required: true },
  products: { type: [mongoose.Schema.Types.Mixed], required: true },
  rows: { type: [mongoose.Schema.Types.Mixed], required: true },
  warnings: { type: [String], default: [] },
  status: { type: String, enum: ['preview', 'committed'], default: 'preview' },
  committedAt: Date,
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ shop: 1, owner: 1 });
export default mongoose.model('ProductImportBatch', schema);
