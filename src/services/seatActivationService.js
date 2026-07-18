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

/**
 * Reclaims a staff email reserved by a seat-addition payment that didn't pan
 * out (failed, cancelled, timed out). Without this, the reserved-but-never-
 * activated User row would permanently block the owner from retrying with
 * that same email. No-ops for non-seat payments or once the staff is active.
 */
export async function cleanupFailedSeatPayment(payment) {
  if (payment.purpose !== 'seat_addition' || !payment.pendingStaff) return;

  const staff = await User.findById(payment.pendingStaff);
  if (staff && !staff.isActive) await staff.deleteOne();
}
