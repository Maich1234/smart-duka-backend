import { getMessaging } from 'firebase-admin/messaging';
import { getFirebaseAdmin, isFirebaseConfigured } from '../config/firebaseAdmin.js';
import User from '../models/User.js';

/**
 * Sends a push notification to every device token registered for a user,
 * via the Firebase Admin SDK. Automatically prunes tokens Firebase reports
 * as invalid/unregistered so the list doesn't grow stale.
 */
export const sendPushToUser = async (user, { title, body, data } = {}) => {
  if (!isFirebaseConfigured()) {
    console.warn('Firebase Admin not configured — skipping push notification');
    return { sent: 0, failed: 0 };
  }

  const tokens = user.fcmTokens || [];
  if (tokens.length === 0) return { sent: 0, failed: 0 };

  const app = getFirebaseAdmin();
  const response = await getMessaging(app).sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : undefined,
  });

  const invalidTokens = [];
  response.responses.forEach((res, i) => {
    if (!res.success) {
      const code = res.error?.code;
      if (code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered') {
        invalidTokens.push(tokens[i]);
      }
    }
  });

  if (invalidTokens.length > 0) {
    await User.updateOne({ _id: user._id }, { $pull: { fcmTokens: { $in: invalidTokens } } });
  }

  return { sent: response.successCount, failed: response.failureCount };
};
