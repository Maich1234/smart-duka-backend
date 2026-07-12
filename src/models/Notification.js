import mongoose from 'mongoose';

// One persisted record per recipient per push — written by utils/push.js
// regardless of whether the Firebase send itself succeeds, so the in-app
// inbox has content even when a device never had push permission granted.
const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  title: { type: String, required: true, trim: true },
  body: { type: String, required: true, trim: true },
  data: { type: Map, of: String, default: undefined },
  // Mirrors data.type at write time (e.g. 'depletion_alert', 'shift_closed',
  // 'campaign') — kept as its own field so listing/filtering doesn't need to
  // reach into the Map.
  type: { type: String, default: 'general' },
  read: { type: Boolean, default: false },
  readAt: { type: Date, default: null },
}, { timestamps: true });

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, read: 1 });

export default mongoose.model('Notification', notificationSchema);
