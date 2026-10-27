import mongoose from 'mongoose';
// No TTL: this identity must outlive a delayed mobile retry.
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true },
  key: { type: String, required: true, maxlength: 128 },
  digest: { type: String, required: true },
  result: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true });
schema.index({ user: 1, key: 1 }, { unique: true });
export default mongoose.model('SaleOperation', schema);
