import mongoose from 'mongoose';

// One thread per owner's chat with Dukana AI. `owner` is explicit rather
// than inferred from `shop` so a future multi-owner shop still scopes
// conversations per person, not per shop.
const conversationSchema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Lazily set from the first user message, truncated — used for a future
  // conversation-list screen; v1 mobile only ever opens the latest thread.
  title: { type: String, trim: true, maxlength: 80, default: null },
  lastMessageAt: { type: Date, default: Date.now },
  messageCount: { type: Number, default: 0 },
  // Monotonic ordinal source for Message.turnIndex — avoids a second query
  // to find "the last turn's index" before inserting the next batch.
  nextTurnIndex: { type: Number, default: 0 },
  // Soft delete only — an AI transcript is never hard-deleted.
  archived: { type: Boolean, default: false },
}, { timestamps: true });

conversationSchema.index({ shop: 1, owner: 1, lastMessageAt: -1 });

export default mongoose.model('Conversation', conversationSchema);
