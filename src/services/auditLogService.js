import AuditLog from '../models/AuditLog.js';

/**
 * Records an immutable audit event. Never throws — logging failures must not
 * break the primary operation. Errors are swallowed and printed to stderr.
 *
 * @param {Object} opts
 * @param {import('mongoose').Types.ObjectId|string} opts.shopId
 * @param {import('mongoose').Types.ObjectId|string} [opts.userId]
 * @param {string} opts.action  - Dot-namespaced e.g. 'payment_config.mpesa.updated'
 * @param {string} [opts.entityType]
 * @param {import('mongoose').Types.ObjectId|string} [opts.entityId]
 * @param {Object} [opts.details] - Non-sensitive context (no credentials)
 * @param {import('express').Request} [opts.req] - Used to extract IP + user agent
 */
export async function logAudit({ shopId, userId, action, entityType, entityId, details, req }) {
  try {
    await AuditLog.create({
      shopId,
      userId,
      action,
      entityType,
      entityId,
      details,
      ipAddress: req?.ip ?? req?.headers?.['x-forwarded-for']?.split(',')[0],
      userAgent: req?.headers?.['user-agent'],
    });
  } catch (err) {
    console.error('[AuditLog] Failed to write audit event:', action, err.message);
  }
}
