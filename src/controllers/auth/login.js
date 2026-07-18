import User from '../../models/User.js';
import RefreshToken from '../../models/RefreshToken.js';
import generateToken from '../../utils/generateToken.js';
import { issueRefreshToken, revokeAllSessions } from '../../services/refreshTokenService.js';
import { logAudit } from '../../services/auditLogService.js';
import { sendPushToUser } from '../../utils/push.js';

export const login = async (req, res) => {
  const { email, password, device } = req.body;

  const user = await User.findOne({ email }).populate('shop');
  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }

  if (!user.isActive) {
    return res.status(401).json({ success: false, message: 'Account deactivated. Please contact owner.' });
  }

  if (!user.isEmailVerified) {
    return res.status(401).json({ success: false, message: 'Please verify your email before logging in.' });
  }

  const isPasswordMatch = await user.comparePassword(password);
  if (!isPasswordMatch) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }

  const token = generateToken(user._id);

  // Staff seats are one-device-at-a-time; owners may run several devices at
  // once (phone/tablet/office computer) by design. A same-device re-login
  // (app reinstall, cleared storage) also gets revoked here rather than left
  // to expire on its own — otherwise it'd sit as a second valid session for
  // the same device until its 30-day TTL, quietly defeating the invariant.
  if (user.role === 'staff' && device?.deviceId) {
    const priorSessions = await RefreshToken.find({ user: user._id, revokedAt: null, expiresAt: { $gt: new Date() } });
    const otherDeviceSessions = priorSessions.filter((s) => s.deviceId !== device.deviceId);
    if (priorSessions.length > 0) {
      await revokeAllSessions(user._id, otherDeviceSessions.length > 0 ? 'superseded_by_new_device' : 'rotated');
    }
    if (otherDeviceSessions.length > 0) {
      // Best-effort: tell the superseded device to check itself and log out
      // now instead of waiting out its access token. Broadcasts to every
      // FCM token on the account (not device-scoped), so the payload carries
      // the *revoked* deviceId — the client only acts if it matches its own.
      // Awaited (not fire-and-forget) — a serverless instance can freeze
      // right after the response is sent, per the idempotency middleware's
      // same precaution.
      await sendPushToUser(user, {
        title: 'Signed out',
        body: 'Your account was signed in on another device.',
        data: { type: 'force_logout', deviceId: otherDeviceSessions[0].deviceId },
      }).catch((err) => console.error('[login] force-logout push failed', err.message));
    }
  }

  // Long-lived rotating refresh token so short access tokens never log a
  // cashier out mid-shift. Older clients that ignore this field keep working
  // (they just get signed out when the access token expires).
  const refreshToken = await issueRefreshToken(user._id, device);
  const userResponse = user.toObject();
  delete userResponse.password;

  await logAudit({
    shopId: user.shop._id,
    userId: user._id,
    action: 'auth.login',
    entityType: 'RefreshToken',
    details: { deviceId: device?.deviceId, deviceName: device?.deviceName, platform: device?.platform },
    req,
  });

  res.json({ success: true, data: { ...userResponse, token, refreshToken } });
};