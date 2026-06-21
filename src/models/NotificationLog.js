import mongoose from 'mongoose';

const notificationLogSchema = new mongoose.Schema({
  shop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    required: true,
    index: true,
  },
  type: {
    type: String,
    required: true,
  },
  // Dedupe key, e.g. a date string or productId — scoped within (shop, type)
  key: {
    type: String,
    required: true,
  },
  sentAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: false,
});

notificationLogSchema.index({ shop: 1, type: 1, key: 1 }, { unique: true });

export default mongoose.model('NotificationLog', notificationLogSchema);
