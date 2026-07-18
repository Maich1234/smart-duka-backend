import mongoose from 'mongoose';

// Mirrors Gemini's own Content/Part shape field-for-field so a stored
// document can be replayed into ai.chats.create({history}) with zero
// translation — see chatOrchestrator.js's toGeminiContent().
const partSchema = new mongoose.Schema({
  text: { type: String },
  functionCall: {
    id: { type: String },
    name: { type: String },
    args: { type: mongoose.Schema.Types.Mixed },
  },
  functionResponse: {
    id: { type: String },
    name: { type: String },
    response: { type: mongoose.Schema.Types.Mixed },
  },
}, { _id: false });

const messageSchema = new mongoose.Schema({
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
  // Denormalized from conversation.shop — every read filters {conversation,
  // shop} together, defense-in-depth against a leaked/guessed conversation
  // id from another shop.
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
  // Gemini's literal Content.role — fed back into history verbatim, never derived.
  role: { type: String, enum: ['user', 'model'], required: true },
  // Our own semantic tag: which of the four turn shapes this is. Used to
  // filter history replay (user_message/model_answer only, see
  // chatOrchestrator.js Risk 1) and to filter the client-facing API response
  // (tool_call/tool_result are internal plumbing, never sent to a client).
  kind: { type: String, enum: ['user_message', 'tool_call', 'tool_result', 'model_answer'], required: true },
  parts: { type: [partSchema], required: true },
  // Set only on kind:'model_answer' — dedup'd tool names from the turn's
  // preceding tool_call rounds, for the mobile "Based on:" footnote.
  toolsUsed: { type: [String], default: undefined },
  turnIndex: { type: Number, required: true },
}, { timestamps: true });

messageSchema.index({ conversation: 1, turnIndex: 1 });
messageSchema.index({ conversation: 1, shop: 1, kind: 1, createdAt: -1 });

export default mongoose.model('Message', messageSchema);
