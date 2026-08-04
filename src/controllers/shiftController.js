import Shift from '../models/Shift.js';
import User from '../models/User.js';
import NotificationLog from '../models/NotificationLog.js';
import { getActiveShift, buildShiftSummary } from '../services/shiftService.js';
import { sendPushToUser } from '../utils/push.js';
import { logAudit } from '../services/auditLogService.js';
import { parsePagination } from '../utils/pagination.js';

const featureEnabled = (req) => req.user.shop?.shiftManagementEnabled === true;

/**
 * GET /shifts/active — the caller's open shift (or null). The app polls this
 * to decide whether the sales screen is unlocked.
 */
export const getMyActiveShift = async (req, res) => {
  const shift = await getActiveShift(req.user._id);
  res.json({ success: true, data: shift, enabled: featureEnabled(req) });
};

/**
 * POST /shifts/start — opens a work session. One active shift per user,
 * enforced both here and by a partial unique index (concurrent requests).
 */
export const startShift = async (req, res) => {
  if (!featureEnabled(req)) {
    return res.status(400).json({ success: false, message: 'Shift management is not enabled for this shop.' });
  }

  const existing = await getActiveShift(req.user._id);
  if (existing) {
    return res.status(409).json({
      success: false,
      code: 'SHIFT_ALREADY_ACTIVE',
      message: 'You already have an active shift. End it before starting a new one.',
      data: existing,
    });
  }

  const { openingFloat = 0, openingNote, device, startedAt } = req.body;

  // A client-supplied start time is trusted only within a sane window: it can
  // never be in the future, and never more than a day old. Device clocks are
  // wrong often enough (manual timezone edits, dead RTC after a flat battery)
  // that an unclamped value would silently corrupt shift reports, while the
  // legitimate case — an offline shift replaying from the outbox — is always
  // recent. Anything outside the window falls back to now.
  const MAX_BACKDATE_MS = 24 * 60 * 60 * 1000;
  const requestedStart = startedAt ? new Date(startedAt) : null;
  const now = Date.now();
  const resolvedStart =
    requestedStart &&
    !Number.isNaN(requestedStart.getTime()) &&
    requestedStart.getTime() <= now &&
    now - requestedStart.getTime() <= MAX_BACKDATE_MS
      ? requestedStart
      : new Date();

  let shift;
  try {
    shift = await Shift.create({
      shop: req.user.shop._id,
      staff: req.user._id,
      openingFloat,
      openingNote,
      device,
      startedAt: resolvedStart,
    });
  } catch (err) {
    // Partial unique index tripped — a concurrent request won the race.
    if (err.code === 11000) {
      const winner = await getActiveShift(req.user._id);
      return res.status(409).json({
        success: false,
        code: 'SHIFT_ALREADY_ACTIVE',
        message: 'You already have an active shift.',
        data: winner,
      });
    }
    throw err;
  }

  await logAudit({
    shopId: req.user.shop._id,
    userId: req.user._id,
    action: 'shift.started',
    entityType: 'Shift',
    entityId: shift._id,
    details: { openingFloat },
    req,
  });

  res.status(201).json({ success: true, data: shift, message: 'Shift started' });
};

const notifyOwnersShiftClosed = async (shift, staffName) => {
  // Idempotent per shift — a retried close request must not ping the owner twice.
  try {
    await NotificationLog.create({ shop: shift.shop, type: 'shift_closed', key: String(shift._id) });
  } catch (err) {
    if (err.code === 11000) return; // already notified
    throw err;
  }

  const s = shift.summary;
  const discrepancy = s.cashDiscrepancy ?? 0;
  const discrepancyText =
    discrepancy === 0
      ? 'drawer balanced ✓'
      : discrepancy > 0
        ? `drawer over by ${discrepancy.toFixed(0)}`
        : `drawer SHORT by ${Math.abs(discrepancy).toFixed(0)}`;

  const title = `🧾 ${staffName} closed their shift`;
  const body = `${s.salesCount} sales · ${s.grossSales.toFixed(0)} total (cash ${s.byMethod.cash.total.toFixed(0)}, M-PESA ${s.byMethod.mpesa.total.toFixed(0)}) · ${discrepancyText}`;

  const owners = await User.find({ shop: shift.shop, role: 'owner' });
  for (const owner of owners) {
    // Push is best-effort: FCM retries delivery to offline devices itself,
    // and the report stays available in the app regardless.
    await sendPushToUser(owner, {
      title,
      body,
      data: { type: 'shift_closed', shiftId: String(shift._id) },
    }).catch((err) => console.error('[shift] owner push failed:', err.message));
  }
};

/**
 * POST /shifts/:id/end — reconciles and closes a shift. Staff close their
 * own; owners may force-close any shift in their shop (staff forgot to
 * clock out). Pass `id=current` to close the caller's active shift.
 */
export const endShift = async (req, res) => {
  const { closingCount, closingNote } = req.body;

  let shift;
  if (req.params.id === 'current') {
    shift = await getActiveShift(req.user._id);
    if (!shift) {
      return res.status(404).json({ success: false, code: 'NO_ACTIVE_SHIFT', message: 'You have no active shift.' });
    }
  } else {
    shift = await Shift.findOne({ _id: req.params.id, shop: req.user.shop._id });
    if (!shift) {
      return res.status(404).json({ success: false, message: 'Shift not found' });
    }
    const isOwn = String(shift.staff) === String(req.user._id);
    if (!isOwn && req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'You can only end your own shift.' });
    }
  }

  if (shift.status === 'closed') {
    // Idempotent close — offline queues may retry; return the existing report.
    return res.json({ success: true, data: shift, message: 'Shift already closed' });
  }

  const endedAt = new Date();
  const summary = await buildShiftSummary(shift, { closingCount, endedAt });

  shift.status = 'closed';
  shift.endedAt = endedAt;
  shift.endedBy = req.user._id;
  if (closingCount !== undefined) shift.closingCount = closingCount;
  if (closingNote !== undefined) shift.closingNote = closingNote;
  shift.summary = summary;
  await shift.save();

  await logAudit({
    shopId: shift.shop,
    userId: req.user._id,
    action: 'shift.ended',
    entityType: 'Shift',
    entityId: shift._id,
    details: {
      grossSales: summary.grossSales,
      salesCount: summary.salesCount,
      cashDiscrepancy: summary.cashDiscrepancy,
      forced: String(shift.staff) !== String(req.user._id),
    },
    req,
  });

  const staffUser = await User.findById(shift.staff).select('name');
  await notifyOwnersShiftClosed(shift, staffUser?.name ?? 'A staff member');

  res.json({ success: true, data: shift, message: 'Shift closed' });
};

/**
 * GET /shifts — shop-wide shift history. Owners see everyone; staff see only
 * their own sessions.
 */
export const getShifts = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { shop: req.user.shop._id };
  if (req.user.role !== 'owner') {
    filter.staff = req.user._id;
  } else if (req.query.staffId) {
    filter.staff = req.query.staffId;
  }
  if (req.query.status) filter.status = req.query.status;
  if (req.query.startDate || req.query.endDate) {
    filter.startedAt = {};
    if (req.query.startDate) filter.startedAt.$gte = new Date(req.query.startDate);
    if (req.query.endDate) filter.startedAt.$lte = new Date(req.query.endDate);
  }

  const [shifts, total] = await Promise.all([
    Shift.find(filter).sort({ startedAt: -1 }).skip(skip).limit(limit).populate('staff', 'name'),
    Shift.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: shifts,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

/** GET /shifts/:id — full shift report (owner, or the staff member's own). */
export const getShiftById = async (req, res) => {
  const shift = await Shift.findOne({ _id: req.params.id, shop: req.user.shop._id })
    .populate('staff', 'name')
    .populate('endedBy', 'name');
  if (!shift) {
    return res.status(404).json({ success: false, message: 'Shift not found' });
  }
  if (req.user.role !== 'owner' && String(shift.staff._id) !== String(req.user._id)) {
    return res.status(403).json({ success: false, message: 'Access denied.' });
  }

  // Active shifts get a live, non-persisted summary so the "end shift" screen
  // can preview the reconciliation before committing.
  let live = null;
  if (shift.status === 'active') {
    live = await buildShiftSummary(shift);
  }

  res.json({ success: true, data: shift, liveSummary: live });
};
