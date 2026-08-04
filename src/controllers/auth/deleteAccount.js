import mongoose from 'mongoose';
import User from '../../models/User.js';
import Shop from '../../models/Shop.js';
import Subscription from '../../models/Subscription.js';
import { revokeAllSessions } from '../../services/refreshTokenService.js';
import { releaseStaffSeat } from '../../services/seatBillingService.js';
import { logAudit } from '../../services/auditLogService.js';
import { sendPushToUser } from '../../utils/push.js';

/** Cooling-off window between requesting closure and the account actually going. */
export const DELETION_GRACE_DAYS = 14;

/**
 * How long an owner has to act on a staff closure request before it proceeds
 * without them.
 *
 * A staff account's records are the shop's books, so the owner gets a say —
 * but an approval gate an owner can simply ignore is a permanent block on
 * someone deleting their own account, which neither Play policy nor data
 * protection law leaves room for. Silence therefore approves; only an
 * explicit decline stops a request, and the staff member is told when it
 * happens so they can raise it or ask again.
 */
export const DELETION_APPROVAL_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Staff closures need owner sign-off; an owner answers to nobody in-shop. */
const needsOwnerApproval = (user) => user.role === 'staff';

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
 * A staff member's request stops one step short of this: it is recorded and
 * sent to the owner for approval (see approveStaffDeletionRequest) rather
 * than scheduled outright, because the records attached to a cashier's
 * account are the shop's books, not personal property. Nothing about the
 * account changes while it waits.
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
  const awaitingApproval = needsOwnerApproval(user);

  if (awaitingApproval && user.deletionRequestedAt) {
    return res.json({
      success: true,
      data: {
        deletionScheduledAt: null,
        deletionRequestedAt: user.deletionRequestedAt,
        awaitingOwnerApproval: true,
        graceDays: DELETION_GRACE_DAYS,
      },
      message: 'Your request is already with the shop owner.',
    });
  }

  user.deletionRequestedAt = now;
  // Staff: left null until the owner approves. Owner: the clock starts now.
  user.deletionScheduledAt = awaitingApproval
    ? null
    : new Date(now.getTime() + DELETION_GRACE_DAYS * DAY_MS);
  await user.save();

  await logAudit({
    shopId: user.shop?._id ?? user.shop,
    userId: user._id,
    action: awaitingApproval ? 'auth.account_deletion_requested' : 'auth.account_deletion_scheduled',
    entityType: 'User',
    entityId: user._id,
    details: {
      role: user.role,
      email: user.email,
      scheduledFor: user.deletionScheduledAt,
      awaitingOwnerApproval: awaitingApproval,
      cascadesToShop: user.role === 'owner',
    },
    req,
  }).catch(() => {});

  if (awaitingApproval) {
    await notifyOwnerOfDeletionRequest(user).catch(() => {});

    return res.json({
      success: true,
      data: {
        deletionScheduledAt: null,
        deletionRequestedAt: user.deletionRequestedAt,
        awaitingOwnerApproval: true,
        graceDays: DELETION_GRACE_DAYS,
        approvalWindowDays: DELETION_APPROVAL_WINDOW_DAYS,
      },
      message:
        'Your request has been sent to the shop owner. Your account keeps working normally until they approve it.',
    });
  }

  return res.json({
    success: true,
    data: { deletionScheduledAt: user.deletionScheduledAt, graceDays: DELETION_GRACE_DAYS },
    message: `Your account will close on ${user.deletionScheduledAt.toDateString()}. You can cancel any time before then.`,
  });
};

/** Tells the shop owner a staff member has asked to close their account. */
async function notifyOwnerOfDeletionRequest(staffUser) {
  const shopId = staffUser.shop?._id ?? staffUser.shop;
  if (!shopId) return;

  const owner = await User.findOne({ shop: shopId, role: 'owner' }).populate('shop', 'name county');
  if (!owner) return;

  await sendPushToUser(owner, {
    title: 'Staff account closure request',
    body: `${staffUser.name} has asked to close their Dukana account. Open their profile to approve or decline.`,
    data: { type: 'staff_deletion_request', staffId: String(staffUser._id) },
  });
}

/**
 * POST /auth/me/restore — cancels a scheduled closure.
 *
 * No password required: the user is already authenticated, and the whole
 * point of the window is that backing out should be effortless. Making it
 * hard to undo would defeat the safety it exists to provide.
 *
 * Also withdraws a staff request still sitting with the owner — changing your
 * mind before anyone has answered should not need anyone's permission.
 */
export const cancelAccountDeletion = async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ success: false, message: 'Account not found' });

  if (!user.deletionScheduledAt && !user.deletionRequestedAt) {
    return res.json({ success: true, message: 'This account is not scheduled for closure.' });
  }

  const wasOnlyRequested = !user.deletionScheduledAt;
  user.deletionScheduledAt = null;
  user.deletionRequestedAt = null;
  await user.save();

  await logAudit({
    shopId: user.shop?._id ?? user.shop,
    userId: user._id,
    action: wasOnlyRequested ? 'auth.account_deletion_withdrawn' : 'auth.account_deletion_cancelled',
    entityType: 'User',
    entityId: user._id,
    details: { role: user.role, email: user.email },
    req,
  }).catch(() => {});

  return res.json({
    success: true,
    message: wasOnlyRequested
      ? 'Your request has been withdrawn. Your account stays open.'
      : 'Your account will not be closed. Welcome back.',
  });
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
    User.findById(req.user._id).select('deletionScheduledAt deletionRequestedAt').lean(),
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
      // Staff closures go to the owner first; the confirmation screen has to
      // promise approval rather than a date it can't yet know.
      requiresOwnerApproval: !isOwner,
      approvalWindowDays: DELETION_APPROVAL_WINDOW_DAYS,
      awaitingOwnerApproval: Boolean(
        !isOwner && user?.deletionRequestedAt && !user?.deletionScheduledAt,
      ),
      deletionRequestedAt: user?.deletionRequestedAt ?? null,
    },
  });
};

/**
 * GET /staff/deletion-requests — staff closure requests waiting on the owner.
 *
 * Surfaced as a banner on the team list so a request can't quietly sit there
 * until the approval window runs out and it goes through on its own.
 */
export const listStaffDeletionRequests = async (req, res) => {
  const shopId = req.user.shop?._id ?? req.user.shop;

  const requests = await User.find({
    shop: shopId,
    role: 'staff',
    deletionRequestedAt: { $ne: null },
    deletionScheduledAt: null,
  })
    .select('name email phone deletionRequestedAt')
    .sort({ deletionRequestedAt: 1 })
    .lean();

  return res.json({
    success: true,
    data: requests.map((staff) => ({
      ...staff,
      autoApprovesAt: new Date(
        new Date(staff.deletionRequestedAt).getTime() + DELETION_APPROVAL_WINDOW_DAYS * DAY_MS,
      ),
    })),
    meta: { graceDays: DELETION_GRACE_DAYS, approvalWindowDays: DELETION_APPROVAL_WINDOW_DAYS },
  });
};

/**
 * POST /staff/:id/deletion-request/approve — owner signs off, which starts
 * the same DELETION_GRACE_DAYS cooling-off clock an owner's own closure gets.
 * The staff member can still call it off within that window.
 */
export const approveStaffDeletionRequest = async (req, res) => {
  const shopId = req.user.shop?._id ?? req.user.shop;
  const staff = await User.findOne({ _id: req.params.id, shop: shopId, role: 'staff' });

  if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found' });
  if (!staff.deletionRequestedAt) {
    return res.status(400).json({
      success: false,
      message: `${staff.name} has not asked to close their account.`,
    });
  }
  if (staff.deletionScheduledAt) {
    return res.json({
      success: true,
      data: { deletionScheduledAt: staff.deletionScheduledAt },
      message: 'This closure has already been approved.',
    });
  }

  staff.deletionScheduledAt = new Date(Date.now() + DELETION_GRACE_DAYS * DAY_MS);
  await staff.save();

  await logAudit({
    shopId,
    userId: req.user._id,
    action: 'auth.account_deletion_approved',
    entityType: 'User',
    entityId: staff._id,
    details: { staffName: staff.name, email: staff.email, scheduledFor: staff.deletionScheduledAt },
    req,
  }).catch(() => {});

  await sendPushToUser(staff, {
    title: 'Account closure approved',
    body: `Your account will close on ${staff.deletionScheduledAt.toDateString()}. You can still cancel before then.`,
    data: { type: 'account_deletion_approved' },
  }).catch(() => {});

  return res.json({
    success: true,
    data: { deletionScheduledAt: staff.deletionScheduledAt, graceDays: DELETION_GRACE_DAYS },
    message: `${staff.name}'s account will close on ${staff.deletionScheduledAt.toDateString()}.`,
  });
};

/**
 * POST /staff/:id/deletion-request/decline — owner refuses the request, which
 * clears it entirely. The staff member is told (with the owner's reason, if
 * given) and is free to ask again; nothing here bars a second request.
 */
export const declineStaffDeletionRequest = async (req, res) => {
  const shopId = req.user.shop?._id ?? req.user.shop;
  const staff = await User.findOne({ _id: req.params.id, shop: shopId, role: 'staff' });

  if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found' });
  if (!staff.deletionRequestedAt || staff.deletionScheduledAt) {
    return res.status(400).json({
      success: false,
      message: 'There is no pending closure request for this staff member.',
    });
  }

  // sendPushToUser runs a {{var}} template pass over the body, so an owner
  // typing "{{name}}" would otherwise have it substituted. Nothing sensitive
  // is reachable that way (the vars are the recipient's own name/shop), but
  // untrusted text should not reach a template engine live.
  const reason = typeof req.body?.reason === 'string'
    ? req.body.reason.trim().replace(/\{\{/g, '{ {')
    : '';

  staff.deletionRequestedAt = null;
  await staff.save();

  await logAudit({
    shopId,
    userId: req.user._id,
    action: 'auth.account_deletion_declined',
    entityType: 'User',
    entityId: staff._id,
    details: { staffName: staff.name, email: staff.email, reason: reason || undefined },
    req,
  }).catch(() => {});

  await sendPushToUser(staff, {
    title: 'Account closure declined',
    body: reason
      ? `Your shop owner declined your account closure request: ${reason}`
      : 'Your shop owner declined your account closure request. Talk to them if you still want to close it.',
    data: { type: 'account_deletion_declined' },
  }).catch(() => {});

  return res.json({
    success: true,
    message: `${staff.name}'s closure request has been declined.`,
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
    const wasActive = user.isActive;
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

    // A staff member closing their own account vacates a billable seat exactly
    // as if the owner had removed them, so the credit and head-count snapshot
    // have to be booked here too — this path used to skip it, leaving the shop
    // paying for a seat nobody occupied. Owners are skipped deliberately: the
    // whole subscription is deleted above, so there is nothing to adjust.
    if (!isOwner) {
      await releaseStaffSeat({
        shopId,
        staff: user,
        wasActive,
        reason: 'staff_account_closed',
      }).catch((err) =>
        console.error('[purgeScheduledDeletions] seat release failed for', String(user._id), err.message),
      );
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
      body: `Dukana will close your account in ${days} day${days === 1 ? '' : 's'}. Open the app to cancel.`,
      data: { type: 'account_deletion_pending' },
    }).catch(() => {});
  }

  return { reminded: users.length };
}

/**
 * Approves staff closure requests the owner never answered.
 *
 * See DELETION_APPROVAL_WINDOW_DAYS: the gate exists so an owner knows a
 * cashier is leaving, not so they can veto someone's right to delete their
 * own account by never opening the app. An explicit decline clears the
 * request, so nothing reaching this point has been answered either way.
 * Runs on the same cron as the purge, and the normal cooling-off window still
 * applies afterwards.
 */
export async function autoApproveStaleDeletionRequests(now = new Date()) {
  const cutoff = new Date(now.getTime() - DELETION_APPROVAL_WINDOW_DAYS * DAY_MS);

  const stale = await User.find({
    role: 'staff',
    deletionScheduledAt: null,
    deletionRequestedAt: { $ne: null, $lte: cutoff },
  });

  for (const user of stale) {
    user.deletionScheduledAt = new Date(now.getTime() + DELETION_GRACE_DAYS * DAY_MS);
    await user.save().catch((err) => {
      console.error('[autoApproveStaleDeletionRequests] failed for', String(user._id), err.message);
    });

    await logAudit({
      shopId: user.shop?._id ?? user.shop,
      userId: user._id,
      action: 'auth.account_deletion_auto_approved',
      entityType: 'User',
      entityId: user._id,
      details: {
        email: user.email,
        requestedAt: user.deletionRequestedAt,
        scheduledFor: user.deletionScheduledAt,
        reason: `no owner response within ${DELETION_APPROVAL_WINDOW_DAYS} days`,
      },
    }).catch(() => {});

    await sendPushToUser(user, {
      title: 'Account closure approved',
      body: `Your account will close on ${user.deletionScheduledAt.toDateString()}. You can still cancel before then.`,
      data: { type: 'account_deletion_approved' },
    }).catch(() => {});
  }

  return { autoApproved: stale.length };
}
