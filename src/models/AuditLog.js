import mongoose from 'mongoose';

// Immutable audit trail for all sensitive payment system actions.
// Records are write-only: no updates or deletes permitted.
const auditLogSchema = new mongoose.Schema({
  shopId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shop',
    // Omitted for platform-scoped admin actions (e.g. platform payment
    // credential changes), which have no owning shop.
    index: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true,
  },
  // Dot-namespaced action descriptor, e.g. 'payment_config.mpesa.updated'
  action: { type: String, required: true, index: true },
  entityType: { type: String },   // e.g. 'PaymentConfig', 'MpesaTransaction'
  entityId: { type: mongoose.Schema.Types.ObjectId },
  // Non-sensitive context: env, shortcode, status changes — never raw credentials
  details: { type: mongoose.Schema.Types.Mixed },
  ipAddress: { type: String },
  userAgent: { type: String },
}, {
  timestamps: true,
  versionKey: false,
});

export default mongoose.model('AuditLog', auditLogSchema);
