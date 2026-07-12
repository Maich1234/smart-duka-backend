import AuditLog from '../models/AuditLog.js';
import { parsePagination } from '../utils/pagination.js';

/** GET /admin/audit — paginated, newest first. Optional ?shopId=&action= filters. Read-only (AuditLog is write-only from the app's side). */
export const listAuditLogs = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 30, maxLimit: 100 });
  const filter = {};
  if (req.query.shopId) filter.shopId = req.query.shopId;
  if (req.query.action) filter.action = req.query.action;

  const [logs, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('shopId', 'name')
      .populate('userId', 'name email')
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  res.json({ success: true, data: logs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};
