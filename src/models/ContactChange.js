import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, required: true },
  field: { type: String, enum: ['email', 'phone'], required: true },
  destination: { type: String, required: true },
  codeHash: { type: String, required: true },
  attempts: { type: Number, required: true },
  nextSendAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  consumedAt: { type: Date, default: null },
});

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('ContactChange', schema);
