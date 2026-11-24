import mongoose from 'mongoose';

const supportSessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true },
  expiresAt: { type: Date, required: true },
  endedAt: { type: Date, default: null },
});

supportSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('SupportSession', supportSessionSchema);
