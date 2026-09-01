import User from '../../../models/User.js';

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
