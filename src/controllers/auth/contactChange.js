import { createHmac, timingSafeEqual } from 'node:crypto';
import ContactChange from '../../models/ContactChange.js';
import User from '../../models/User.js';
import { logAudit } from '../../services/auditLogService.js';
import { sendSMS } from '../../services/bongaSmsService.js';
import { revokeAllSessions } from '../../services/refreshTokenService.js';
import { sendEmail } from '../../utils/email.js';
import { generateOTP } from '../../utils/generateOTP.js';
import { notifySecurityEvent } from '../../utils/securityAlerts.js';
import { isAnySystemGeneratedEmail } from '../../utils/staffEmailSlug.js';

const CODE_LIFETIME_MS = 10 * 60_000;
const RESEND_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 5;

function hashCode(user, field, destination, code) {
  return createHmac('sha256', process.env.JWT_SECRET)
    .update(JSON.stringify(['contact-change', String(user._id), user.password, user[field], field, destination, code]))
    .digest();
}

export async function requestContactChange(req, res) {
  const { field, destination, currentPassword } = req.body;
  const user = await User.findOne({ _id: req.user._id, isActive: true });
  if (!user || !(await user.comparePassword(currentPassword))) {
    return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
  }
  if (destination === user[field] || (field === 'email' && isAnySystemGeneratedEmail(destination))) {
    return res.status(400).json({ success: false, message: 'Enter a different contact you can access.' });
  }

  const code = generateOTP();
  const codeHash = hashCode(user, field, destination, code).toString('hex');
  const now = Date.now();
  try {
    await ContactChange.updateOne(
      { _id: user._id, nextSendAt: { $lte: new Date(now) } },
      { $set: {
        field, destination, codeHash, attempts: 0, consumedAt: null,
        nextSendAt: new Date(now + RESEND_DELAY_MS),
        expiresAt: new Date(now + CODE_LIFETIME_MS),
      } },
      { upsert: true },
    );
  } catch (err) {
    if (err.code !== 11000) throw err;
    return res.status(429).json({ success: false, message: 'Wait one minute between code requests.' });
  }

  const message = `Your DuQana contact change code is ${code}. It expires in 10 minutes. Do not share it.`;
  try {
    if (field === 'email') {
      await sendEmail(destination, 'Confirm your DuQana email change', `<p>${message}</p>`, message);
    } else {
      await sendSMS(destination, message);
    }
  } catch {
    return res.status(503).json({ success: false, message: 'The code could not be delivered. Try again in a minute.' });
  }
  return res.json({ success: true, message: 'Verification code sent.' });
}

export async function confirmContactChange(req, res) {
  const { field, code } = req.body;
  const invalid = () => res.status(400).json({ success: false, message: 'Invalid or expired verification code.' });
  const challenge = await ContactChange.findOneAndUpdate(
    { _id: req.user._id, field, consumedAt: null, expiresAt: { $gt: new Date() }, attempts: { $lt: MAX_ATTEMPTS } },
    { $inc: { attempts: 1 } },
  );
  if (!challenge) return invalid();

  let previousUser;
  try {
    await User.db.transaction(async (session) => {
      previousUser = null;
      const user = await User.findOne({ _id: req.user._id, isActive: true }).session(session);
      if (!user || !/^[a-f0-9]{64}$/.test(challenge.codeHash) ||
          !timingSafeEqual(Buffer.from(challenge.codeHash, 'hex'), hashCode(user, field, challenge.destination, code))) return;
      const now = new Date();
      const claimed = await ContactChange.updateOne(
        { _id: user._id, codeHash: challenge.codeHash, consumedAt: null, expiresAt: { $gt: now } },
        { $set: { consumedAt: now } },
        { session },
      );
      if (!claimed.modifiedCount) return;

      const updates = field === 'email'
        ? { email: challenge.destination, isEmailVerified: true }
        : { phone: challenge.destination };
      await User.updateOne({ _id: user._id }, { $set: updates }, { session, runValidators: true });
      await revokeAllSessions(user._id, 'contact_change', session);
      previousUser = user;
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    return res.status(409).json({ success: false, message: 'This email cannot be used.' });
  }
  if (!previousUser) return invalid();

  await logAudit({ shopId: previousUser.shop, userId: previousUser._id, action: 'auth.contact_changed', details: { field }, req });
  await notifySecurityEvent(previousUser, 'profile_updated', { req });
  return res.json({ success: true, message: 'Contact updated. Sign in again to continue.' });
}
