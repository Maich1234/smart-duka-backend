import Notification from '../models/Notification.js';
import { parsePagination } from '../utils/pagination.js';

/** GET /notifications — this user's inbox, newest first. ?unread=true filters to unread only. */
export const listNotifications = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const filter = { user: req.user._id };
  if (req.query.unread === 'true') filter.read = false;

  const [notifications, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
  ]);

  res.json({ success: true, data: notifications, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};

/** GET /notifications/unread-count — feeds the bell badge. */
export const getUnreadCount = async (req, res) => {
  const count = await Notification.countDocuments({ user: req.user._id, read: false });
  res.json({ success: true, data: { count } });
};

/** PATCH /notifications/:id/read */
export const markNotificationRead = async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { $set: { read: true, readAt: new Date() } },
    { new: true }
  );
  if (!notification) {
    return res.status(404).json({ success: false, message: 'Notification not found' });
  }
  res.json({ success: true, data: notification });
};

/** PATCH /notifications/read-all */
export const markAllNotificationsRead = async (req, res) => {
  const now = new Date();
  await Notification.updateMany(
    { user: req.user._id, read: false },
    { $set: { read: true, readAt: now } }
  );
  res.json({ success: true, message: 'All notifications marked as read' });
};
