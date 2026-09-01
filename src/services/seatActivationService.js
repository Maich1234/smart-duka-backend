import User from '../models/User.js';
import Subscription from '../models/Subscription.js';
import { sendVerificationEmail } from '../utils/emailVerification.js';

/**
 * Activates the staff account a successful seat-addition payment was for.
 * Idempotent — safe to call more than once (webhook + recheck can race):
 * no-ops if the pending staff is gone or already active.
 */
export async function activateSeatPayment(payment) {
  if (!payment.pendingStaff) return;

  const staff = await User.findById(payment.pendingStaff);
  if (!staff || staff.isActive) return;

  staff.isActive = true;
  await staff.save();

  // Real (non-system-generated) email — this is the first point the staff
  // account is "real", so this is where the invite email goes out.
  if (!staff.isEmailVerified) {
    sendVerificationEmail(staff).catch((err) => console.error('[activateSeatPayment] verification email failed:', err.message));
  }

  await Subscription.updateOne({ _id: payment.subscription }, { $set: { staffCount: payment.staffCount } });
}
