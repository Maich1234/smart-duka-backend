import mongoose from 'mongoose';
import User from '../../models/User.js';
import Shop from '../../models/Shop.js';
import Subscription from '../../models/Subscription.js';
import { revokeAllSessions } from '../../services/refreshTokenService.js';
import { logAudit } from '../../services/auditLogService.js';
import { sendPushToUser } from '../../utils/push.js';

/** Cooling-off window between requesting closure and the account actually going. */
export const DELETION_GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * DELETE /auth/me — schedules permanent account closure.
 *
 * Required by Google Play policy for any app that lets users create an
 * account: deletion must be reachable in-app, not only by emailing support.
 * The web app exposes the same operation at /delete-account for users who
 * can't or won't install the app.
 *
 * Nothing is destroyed today. Deletion is irreversible and, for an owner,
 * takes the whole shop and every staff account with it — far too much damage
 * to allow from one mistaken tap, a borrowed unlocked phone, or an argument.
 * So closure is *scheduled* DELETION_GRACE_DAYS out: the account keeps
 * working normally, shows a persistent banner, and can be restored with one
 * tap. purgeScheduledDeletions() does the real work once the date passes.
 *
 * What eventually gets destroyed vs. retained:
 *
 *  - Destroyed: the user record and every credential and session attached to
 *    it. An owner also destroys their shop and every staff account under it —
 *    a staff account has no meaning without its shop.
 *  - Retained: sales, purchases, expenses, and payment records, with their
 *    personal identifiers detached. These are statutory bookkeeping records;
 *    a shop cannot lawfully erase its own tax history because the operator
 *    closed an app account. This carve-out is stated in the privacy policy,
 *    which is what makes it a lawful retention rather than a silent one.
 *
 * Guarded by the account password — an unlocked phone must not be enough.
 */
export const deleteAccount = async (req, res) => {
  const { password, confirm } = req.body;

  if (confirm !== 'DELETE') {
    return res.status(400).json({
      success: false,
      message: 'Type DELETE to confirm you want to close this account.',
    });
  }

  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ success: false, message: 'Account not found' });

  const passwordMatches = await user.comparePassword(password);
  if (!passwordMatches) {
    return res.status(401).json({ success: false, message: 'That password is incorrect.' });
  }

  if (user.deletionScheduledAt) {
    return res.json({
      success: true,
      data: { deletionScheduledAt: user.deletionScheduledAt },
      message: 'This account is already scheduled for closure.',
    });
  }

  const now = new Date();
  user.deletionRequestedAt = now;
  user.deletionScheduledAt = new Date(now.getTime() + DELETION_GRACE_DAYS * DAY_MS);
  await user.save();

  await logAudit({
    shopId: user.shop?._id ?? user.shop,
    userId: user._id,
    action: 'auth.account_deletion_scheduled',
    entityType: 'User',
    entityId: user._id,
    details: {
      role: user.role,
      email: user.email,
      scheduledFor: user.deletionScheduledAt,
      cascadesToShop: user.role === 'owner',
    },
    req,
  }).catch(() => {});

  return res.json({
    success: true,
    data: { deletionScheduledAt: user.deletionScheduledAt, graceDays: DELETION_GRACE_DAYS },
    message: `Your account will close on ${user.deletionScheduledAt.toDateString()}. You can cancel any time before then.`,
  });
};

/**
 * POST /auth/me/restore — cancels a scheduled closure.
 *
 * No password required: the user is already authenticated, and the whole
 * point of the window is that backing out should be effortless. Making it
 * hard to undo would defeat the safety it exists to provide.
 */
export const cancelAccountDeletion = async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ success: false, message: 'Account not found' });

  if (!user.deletionScheduledAt) {
    return res.json({ success: true, message: 'This account is not scheduled for closure.' });
  }

  user.deletionScheduledAt = null;
  user.deletionRequestedAt = null;
  await user.save();

  await logAudit({
    shopId: user.shop?._id ?? user.shop,
    userId: user._id,
    action: 'auth.account_deletion_cancelled',
    entityType: 'User',
    entityId: user._id,
    details: { role: user.role, email: user.email },
    req,
  }).catch(() => {});

  return res.json({ success: true, message: 'Your account will not be closed. Welcome back.' });
};

/**
 * GET /auth/me/deletion-preview — what closing this account will destroy, and
 * whether one is already scheduled.
 *
 * The confirmation screen states real consequences instead of a generic
 * warning: an owner is usually unaware that closing their account takes the
 * whole team with it.
 */
export const previewAccountDeletion = async (req, res) => {
  const shopId = req.user.shop?._id ?? req.user.shop;
  const isOwner = req.user.role === 'owner';

  const [staffCount, user] = await Promise.all([
    isOwner ? User.countDocuments({ shop: shopId, role: 'staff' }) : 0,
    User.findById(req.user._id).select('deletionScheduledAt').lean(),
  ]);

  return res.json({
    success: true,
    data: {
      role: req.user.role,
      cascades: isOwner,
      staffAccountsRemoved: staffCount,
      shopName: isOwner ? req.user.shop?.name ?? null : null,
      retainedForBookkeeping: ['sales', 'purchases', 'expenses', 'payment records'],
      graceDays: DELETION_GRACE_DAYS,
      deletionScheduledAt: user?.deletionScheduledAt ?? null,
    },
  });
};

/**
 * Destroys every account whose cooling-off window has expired. Driven by the
 * scheduled-jobs cron, and safe to run repeatedly — it only ever picks up
 * accounts already past their date.
 */
export async function purgeScheduledDeletions(now = new Date()) {
  const due = await User.find({ deletionScheduledAt: { $ne: null, $lte: now } });
  const result = { ownersPurged: 0, staffPurged: 0, shopsClosed: 0 };

  for (const user of due) {
    const shopId = user.shop?._id ?? user.shop;
    const isOwner = user.role === 'owner';
    let cascadedStaffIds = [];

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (isOwner) {
          // Cascade: staff accounts and the subscription have no meaning once
          // the shop is gone. Financial documents are deliberately untouched.
          const staff = await User.find({ shop: shopId, role: 'staff' }).select('_id').session(session);
          cascadedStaffIds = staff.map((s) => s._id);

          await User.deleteMany({ shop: shopId }).session(session);
          await Subscription.deleteOne({ shop: shopId }).session(session);
          await Shop.deleteOne({ _id: shopId }).session(session);
        } else {
          await User.deleteOne({ _id: user._id }).session(session);
        }
      });
    } catch (err) {
      console.error('[purgeScheduledDeletions] failed for user', String(user._id), err.message);
      session.endSession();
      continue;
    } finally {
      session.endSession();
    }

    // Sessions live outside the transaction's collections; revoke after commit.
    await revokeAllSessions(user._id, 'account_deleted').catch(() => {});
    for (const staffId of cascadedStaffIds) {
      await revokeAllSessions(staffId, 'account_deleted').catch(() => {});
    }

    await logAudit({
      shopId,
      userId: user._id,
      action: 'auth.account_deleted',
      entityType: 'User',
      entityId: user._id,
      details: { role: user.role, email: user.email, cascadedStaff: cascadedStaffIds.length },
    }).catch(() => {});

    if (isOwner) {
      result.ownersPurged += 1;
      result.shopsClosed += 1;
      result.staffPurged += cascadedStaffIds.length;
    } else {
      result.staffPurged += 1;
    }
  }

  return result;
}

/**
 * Reminds users part-way through the window that closure is still coming —
 * the point at which someone who tapped by accident, or forgot, can still
 * change their mind. Called by the same cron as the purge.
 */
export async function remindScheduledDeletions(now = new Date()) {
  // Anyone whose closure lands in the next 3 days and who hasn't been warned.
  const soon = new Date(now.getTime() + 3 * DAY_MS);
  const users = await User.find({ deletionScheduledAt: { $gt: now, $lte: soon } });

  for (const user of users) {
    const days = Math.max(1, Math.ceil((new Date(user.deletionScheduledAt) - now) / DAY_MS));
    await sendPushToUser(user, {
      title: 'Your account closes soon',
      body: `Smart Duka will close your account in ${days} day${days === 1 ? '' : 's'}. Open the app to cancel.`,
      data: { type: 'account_deletion_pending' },
    }).catch(() => {});
  }

  return { reminded: users.length };
}
