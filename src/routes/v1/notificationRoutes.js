import express from 'express';
import {
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from '../../controllers/notificationController.js';
import { protect, staffOrOwner } from '../../middlewares/auth.js';

const router = express.Router();

router.use(protect);
router.get('/', staffOrOwner, listNotifications);
router.get('/unread-count', staffOrOwner, getUnreadCount);
router.patch('/read-all', staffOrOwner, markAllNotificationsRead);
router.patch('/:id/read', staffOrOwner, markNotificationRead);

export default router;
