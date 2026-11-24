import { createHmac, timingSafeEqual } from 'node:crypto';
import User from '../../models/User.js';
import OTP from '../../models/OTP.js';
import { generateOTP } from '../../utils/generateOTP.js';
import { sendOTPEmail } from '../../utils/email.js';
import { revokeAllSessions } from '../../services/refreshTokenService.js';
import { logAudit } from '../../services/auditLogService.js';
import { notifySecurityEvent } from '../../utils/securityAlerts.js';
import { isAnySystemGeneratedEmail } from '../../utils/staffEmailSlug.js';

export const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  let user;
  let changed;
  await User.db.transaction(async (session) => {
    changed = false;
    user = await User.findOne({ _id: req.user._id, isActive: true }).session(session);
    if (!user || !(await user.comparePassword(currentPassword))) return;

    user.password = newPassword;
    await user.save({ session });
    await OTP.deleteOne({ _id: user._id }, { session });
    await revokeAllSessions(user._id, 'password_change', session);
    changed = true;
  });

  if (!changed) {
    if (user) {
      await logAudit({ shopId: user.shop, userId: user._id, action: 'auth.password_change_failed', entityType: 'User', req });
      await notifySecurityEvent(user, 'password_change_failed', { req });
    }
    return res.status(401).json({ success: false, message: 'Current password is incorrect' });
  }

  await logAudit({ shopId: user.shop, userId: user._id, action: 'auth.password_change', entityType: 'RefreshToken', req });
  await notifySecurityEvent(user, 'password_change', { req });

  res.json({ success: true, message: 'Password changed successfully' });
};

const RESET_LIFETIME_MS = 10 * 60 * 1000;
const RESEND_DELAY_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const genericResetResponse = {
  success: true,
  message: 'If the account can receive email, we will send a reset code. Staff without an inbox should contact their shop owner.',
};

const resetCodeHash = (email, otp) => createHmac('sha256', process.env.JWT_SECRET)
  .update(JSON.stringify(['password-reset', email, otp]))
  .digest('hex');

export const forgotPassword = async (req, res) => {
  const email = req.body.email.trim().toLowerCase();
  const user = await User.findOne({ email, isActive: true });
  if (user && !isAnySystemGeneratedEmail(user.email)) {
    const otp = generateOTP();
    const now = Date.now();
    let issued = false;
    try {
      await OTP.updateOne(
        { _id: user._id, $or: [{ nextSendAt: { $lte: new Date(now) } }, { nextSendAt: { $exists: false } }] },
        { $set: {
          email,
          codeHash: resetCodeHash(email, otp),
          attempts: 0,
          expiresAt: new Date(now + RESET_LIFETIME_MS),
          nextSendAt: new Date(now + RESEND_DELAY_MS),
          consumedAt: null,
        } },
        { upsert: true },
      );
      issued = true;
    } catch (err) {
      if (err.code !== 11000) throw err;
    }

    if (issued) {
      try {
        await sendOTPEmail(email, otp, user.name);
      } catch (err) {
        console.error('[forgotPassword] reset email delivery failed', err.code);
      }
    }
  }
  return res.json(genericResetResponse);
};

async function checkResetCode(email, otp) {
  const now = new Date();
  const record = await OTP.findOneAndUpdate(
    { email, codeHash: { $exists: true }, expiresAt: { $gt: now }, consumedAt: null, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
  );
  if (!record || !/^[a-f0-9]{64}$/.test(record.codeHash)) return null;
  if (!timingSafeEqual(Buffer.from(record.codeHash, 'hex'), Buffer.from(resetCodeHash(email, otp), 'hex'))) return null;
  return record;
}

function invalidCode(res) {
  return res.status(400).json({
    success: false,
    message: 'Invalid or expired reset code',
    fieldErrors: [{ field: 'otp', message: 'Invalid or expired reset code' }],
  });
}

export const verifyOTP = async (req, res) => {
  const { email, otp } = req.body;
  const record = await checkResetCode(email.trim().toLowerCase(), otp);
  if (!record) return invalidCode(res);
  res.json({ success: true, message: 'OTP verified' });
};

export const resetPassword = async (req, res) => {
  const { email, otp, newPassword } = req.body;
  const normalizedEmail = email.trim().toLowerCase();
  const record = await checkResetCode(normalizedEmail, otp);
  if (!record) return invalidCode(res);

  let user;
  await User.db.transaction(async (session) => {
    user = null;
    const account = await User.findOne({ _id: record._id, email: normalizedEmail, isActive: true }).session(session);
    if (!account) return;
    const now = new Date();
    const claim = await OTP.updateOne(
      { _id: record._id, codeHash: record.codeHash, consumedAt: null, expiresAt: { $gt: now } },
      { $set: { consumedAt: now } },
      { session },
    );
    if (!claim.modifiedCount) return;
    account.password = newPassword;
    await account.save({ session });
    await revokeAllSessions(account._id, 'password_change', session);
    user = account;
  });
  if (!user) return invalidCode(res);
  await logAudit({ shopId: user.shop, userId: user._id, action: 'auth.password_change', entityType: 'RefreshToken', req });
  await notifySecurityEvent(user, 'password_change', { req });

  res.json({ success: true, message: 'Password reset successfully' });
};