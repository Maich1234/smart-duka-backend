import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import User from '../src/models/User.js';
import {
  deleteAccount,
  cancelAccountDeletion,
  previewAccountDeletion,
  approveStaffDeletionRequest,
  declineStaffDeletionRequest,
  autoApproveStaleDeletionRequests,
  DELETION_GRACE_DAYS,
  DELETION_APPROVAL_WINDOW_DAYS,
} from '../src/controllers/auth/deleteAccount.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function makeUser(overrides = {}) {
  return {
    _id: 'user-1',
    role: 'owner',
    email: 'owner@shop.test',
    shop: { _id: 'shop-1', name: 'Duka Bora' },
    deletionScheduledAt: null,
    deletionRequestedAt: null,
    comparePassword: async (candidate) => candidate === 'correct-password',
    save: async function () { this.saved = true; },
    ...overrides,
  };
}

const ownerReq = (body) => ({
  body,
  user: { _id: 'user-1', role: 'owner', shop: { _id: 'shop-1', name: 'Duka Bora' } },
  headers: {},
});

beforeEach(() => mock.restoreAll());

test('deleteAccount: schedules closure 14 days out instead of destroying anything now', async () => {
  const user = makeUser();
  mock.method(User, 'findById', async () => user);
  const deleteMany = mock.method(User, 'deleteMany', async () => { throw new Error('must not purge synchronously'); });

  const res = makeRes();
  await deleteAccount(ownerReq({ password: 'correct-password', confirm: 'DELETE' }), res);

  assert.equal(res.statusCode, 200);
  assert.ok(user.deletionScheduledAt, 'closure must be scheduled');
  assert.ok(user.saved);
  assert.equal(deleteMany.mock.callCount(), 0, 'nothing is destroyed during the cooling-off window');

  const days = Math.round((user.deletionScheduledAt - user.deletionRequestedAt) / DAY_MS);
  assert.equal(days, DELETION_GRACE_DAYS);
  assert.equal(res.body.data.graceDays, DELETION_GRACE_DAYS);
});

test('deleteAccount: a wrong password cannot schedule closure', async () => {
  const user = makeUser();
  mock.method(User, 'findById', async () => user);

  const res = makeRes();
  await deleteAccount(ownerReq({ password: 'wrong', confirm: 'DELETE' }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(user.deletionScheduledAt, null, 'an unlocked phone must not be enough');
});

test('deleteAccount: the typed confirmation is required', async () => {
  const user = makeUser();
  mock.method(User, 'findById', async () => user);

  const res = makeRes();
  await deleteAccount(ownerReq({ password: 'correct-password', confirm: 'delete' }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(user.deletionScheduledAt, null);
});

test('deleteAccount: re-requesting does not extend an existing schedule', async () => {
  const original = new Date(Date.now() + 5 * DAY_MS);
  const user = makeUser({ deletionScheduledAt: original });
  mock.method(User, 'findById', async () => user);

  const res = makeRes();
  await deleteAccount(ownerReq({ password: 'correct-password', confirm: 'DELETE' }), res);

  assert.equal(res.body.data.deletionScheduledAt, original, 'the clock must not restart');
  assert.equal(user.saved, undefined);
});

test('cancelAccountDeletion: one call clears the schedule, no password needed', async () => {
  const user = makeUser({ deletionScheduledAt: new Date(Date.now() + 10 * DAY_MS) });
  mock.method(User, 'findById', async () => user);

  const res = makeRes();
  await cancelAccountDeletion({ user: { _id: 'user-1', role: 'owner', shop: { _id: 'shop-1' } }, headers: {} }, res);

  assert.equal(user.deletionScheduledAt, null, 'backing out must be effortless');
  assert.equal(user.deletionRequestedAt, null);
  assert.ok(user.saved);
});

test('previewAccountDeletion: warns an owner that closure takes the whole team', async () => {
  mock.method(User, 'countDocuments', async () => 4);
  mock.method(User, 'findById', () => ({ select: () => ({ lean: async () => ({ deletionScheduledAt: null }) }) }));

  const res = makeRes();
  await previewAccountDeletion(ownerReq({}), res);

  assert.equal(res.body.data.cascades, true);
  assert.equal(res.body.data.staffAccountsRemoved, 4);
  assert.equal(res.body.data.shopName, 'Duka Bora');
  assert.equal(res.body.data.graceDays, DELETION_GRACE_DAYS);
});

test('previewAccountDeletion: a staff closure affects only that one account', async () => {
  const countDocuments = mock.method(User, 'countDocuments', async () => 4);
  mock.method(User, 'findById', () => ({ select: () => ({ lean: async () => ({ deletionScheduledAt: null }) }) }));

  const res = makeRes();
  await previewAccountDeletion(
    { body: {}, user: { _id: 'staff-1', role: 'staff', shop: { _id: 'shop-1' } }, headers: {} },
    res,
  );

  assert.equal(res.body.data.cascades, false);
  assert.equal(res.body.data.staffAccountsRemoved, 0);
  assert.equal(countDocuments.mock.callCount(), 0);
});

test('previewAccountDeletion: reports an already-scheduled closure so the UI can offer a way back', async () => {
  const scheduled = new Date(Date.now() + 7 * DAY_MS);
  mock.method(User, 'countDocuments', async () => 0);
  mock.method(User, 'findById', () => ({ select: () => ({ lean: async () => ({ deletionScheduledAt: scheduled }) }) }));

  const res = makeRes();
  await previewAccountDeletion(ownerReq({}), res);

  assert.equal(res.body.data.deletionScheduledAt, scheduled);
});

// ── Owner approval for staff closures ─────────────────────────────────────
// A cashier's account carries the shop's books, so the owner signs off before
// the cooling-off clock starts — but silence must not become a permanent veto.

const staffReq = (body) => ({
  body,
  user: { _id: 'staff-1', role: 'staff', shop: { _id: 'shop-1', name: 'Duka Bora' } },
  headers: {},
});

const ownerActorReq = (params, body = {}) => ({
  params,
  body,
  user: { _id: 'owner-1', role: 'owner', shop: { _id: 'shop-1', name: 'Duka Bora' } },
  headers: {},
});

test('deleteAccount: a staff request waits on the owner instead of scheduling', async () => {
  const user = makeUser({ _id: 'staff-1', role: 'staff', email: 'cashier@shop.test' });
  mock.method(User, 'findById', async () => user);
  // notifyOwnerOfDeletionRequest looks the owner up; no owner on record is fine.
  mock.method(User, 'findOne', () => ({ populate: async () => null }));

  const res = makeRes();
  await deleteAccount(staffReq({ password: 'correct-password', confirm: 'DELETE' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(user.deletionScheduledAt, null, 'nothing is scheduled until the owner approves');
  assert.ok(user.deletionRequestedAt, 'the request itself is recorded');
  assert.equal(res.body.data.awaitingOwnerApproval, true);
  assert.equal(res.body.data.approvalWindowDays, DELETION_APPROVAL_WINDOW_DAYS);
});

test('deleteAccount: a staff member re-asking does not reset the approval window', async () => {
  const requestedAt = new Date(Date.now() - 3 * DAY_MS);
  const user = makeUser({ _id: 'staff-1', role: 'staff', deletionRequestedAt: requestedAt });
  mock.method(User, 'findById', async () => user);

  const res = makeRes();
  await deleteAccount(staffReq({ password: 'correct-password', confirm: 'DELETE' }), res);

  assert.equal(user.deletionRequestedAt, requestedAt, 'the owner\'s clock must not restart');
  assert.equal(user.saved, undefined);
  assert.equal(res.body.data.awaitingOwnerApproval, true);
});

test('deleteAccount: a staff request still needs the right password', async () => {
  const user = makeUser({ _id: 'staff-1', role: 'staff' });
  mock.method(User, 'findById', async () => user);

  const res = makeRes();
  await deleteAccount(staffReq({ password: 'wrong', confirm: 'DELETE' }), res);

  assert.equal(res.statusCode, 401);
  assert.equal(user.deletionRequestedAt, null);
});

test('previewAccountDeletion: tells a staff member their closure needs owner approval', async () => {
  mock.method(User, 'countDocuments', async () => 0);
  mock.method(User, 'findById', () => ({
    select: () => ({ lean: async () => ({ deletionScheduledAt: null, deletionRequestedAt: new Date() }) }),
  }));

  const res = makeRes();
  await previewAccountDeletion(staffReq({}), res);

  assert.equal(res.body.data.requiresOwnerApproval, true);
  assert.equal(res.body.data.awaitingOwnerApproval, true);
});

test('previewAccountDeletion: an owner never needs anyone else\'s approval', async () => {
  mock.method(User, 'countDocuments', async () => 2);
  mock.method(User, 'findById', () => ({
    select: () => ({ lean: async () => ({ deletionScheduledAt: null, deletionRequestedAt: null }) }),
  }));

  const res = makeRes();
  await previewAccountDeletion(ownerReq({}), res);

  assert.equal(res.body.data.requiresOwnerApproval, false);
  assert.equal(res.body.data.awaitingOwnerApproval, false);
});

test('cancelAccountDeletion: a staff member can withdraw a request the owner has not answered', async () => {
  const user = makeUser({
    _id: 'staff-1',
    role: 'staff',
    deletionScheduledAt: null,
    deletionRequestedAt: new Date(),
  });
  mock.method(User, 'findById', async () => user);

  const res = makeRes();
  await cancelAccountDeletion(staffReq({}), res);

  assert.equal(user.deletionRequestedAt, null, 'withdrawing needs nobody\'s permission');
  assert.ok(user.saved);
  assert.match(res.body.message, /withdrawn/);
});

test('approveStaffDeletionRequest: owner sign-off starts the cooling-off clock', async () => {
  const requestedAt = new Date(Date.now() - 2 * DAY_MS);
  const staff = makeUser({
    _id: 'staff-1',
    role: 'staff',
    name: 'Amina',
    deletionRequestedAt: requestedAt,
  });
  mock.method(User, 'findOne', async () => staff);

  const res = makeRes();
  await approveStaffDeletionRequest(ownerActorReq({ id: 'staff-1' }), res);

  assert.equal(res.statusCode, 200);
  assert.ok(staff.deletionScheduledAt, 'approval is what schedules the closure');
  const days = Math.round((staff.deletionScheduledAt - Date.now()) / DAY_MS);
  assert.equal(days, DELETION_GRACE_DAYS, 'the staff member still gets the full window to change their mind');
});

test('approveStaffDeletionRequest: nothing to approve when no request was made', async () => {
  const staff = makeUser({ _id: 'staff-1', role: 'staff', name: 'Amina' });
  mock.method(User, 'findOne', async () => staff);

  const res = makeRes();
  await approveStaffDeletionRequest(ownerActorReq({ id: 'staff-1' }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(staff.deletionScheduledAt, null);
});

test('approveStaffDeletionRequest: a staff member in another shop is not found', async () => {
  const findOne = mock.method(User, 'findOne', async () => null);

  const res = makeRes();
  await approveStaffDeletionRequest(ownerActorReq({ id: 'staff-elsewhere' }), res);

  assert.equal(res.statusCode, 404);
  // The shop id is part of the lookup, which is what scopes it to this owner.
  assert.deepEqual(findOne.mock.calls[0].arguments[0], {
    _id: 'staff-elsewhere',
    shop: 'shop-1',
    role: 'staff',
  });
});

test('declineStaffDeletionRequest: clears the request and leaves the account untouched', async () => {
  const staff = makeUser({
    _id: 'staff-1',
    role: 'staff',
    name: 'Amina',
    deletionRequestedAt: new Date(),
  });
  mock.method(User, 'findOne', async () => staff);

  const res = makeRes();
  await declineStaffDeletionRequest(ownerActorReq({ id: 'staff-1' }, { reason: 'Finish the stock take first' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(staff.deletionRequestedAt, null);
  assert.equal(staff.deletionScheduledAt, null);
});

test('declineStaffDeletionRequest: cannot un-approve a closure that is already scheduled', async () => {
  const scheduled = new Date(Date.now() + 10 * DAY_MS);
  const staff = makeUser({
    _id: 'staff-1',
    role: 'staff',
    name: 'Amina',
    deletionRequestedAt: new Date(),
    deletionScheduledAt: scheduled,
  });
  mock.method(User, 'findOne', async () => staff);

  const res = makeRes();
  await declineStaffDeletionRequest(ownerActorReq({ id: 'staff-1' }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(staff.deletionScheduledAt, scheduled);
});

test('autoApproveStaleDeletionRequests: an unanswered request is not a permanent veto', async () => {
  const stale = makeUser({
    _id: 'staff-1',
    role: 'staff',
    deletionRequestedAt: new Date(Date.now() - (DELETION_APPROVAL_WINDOW_DAYS + 1) * DAY_MS),
  });
  const find = mock.method(User, 'find', async () => [stale]);

  const result = await autoApproveStaleDeletionRequests();

  assert.equal(result.autoApproved, 1);
  assert.ok(stale.deletionScheduledAt, 'silence approves');
  const days = Math.round((stale.deletionScheduledAt - Date.now()) / DAY_MS);
  assert.equal(days, DELETION_GRACE_DAYS, 'the cooling-off window starts at approval, not at request');

  // Only unanswered staff requests qualify — a decline clears deletionRequestedAt.
  const query = find.mock.calls[0].arguments[0];
  assert.equal(query.role, 'staff');
  assert.equal(query.deletionScheduledAt, null);
});

test('autoApproveStaleDeletionRequests: leaves a request still inside the window alone', async () => {
  const find = mock.method(User, 'find', async () => []);

  const result = await autoApproveStaleDeletionRequests();

  assert.equal(result.autoApproved, 0);
  const cutoff = find.mock.calls[0].arguments[0].deletionRequestedAt.$lte;
  const windowDays = Math.round((Date.now() - cutoff) / DAY_MS);
  assert.equal(windowDays, DELETION_APPROVAL_WINDOW_DAYS);
});

// ── Seat release on purge ──────────────────────────────────────────────────
// A closed staff account vacates a billable seat. This used to be booked only
// when the *owner* removed someone, so self-closure left the shop paying for
// a seat nobody occupied — and it fails silently, which is why it's pinned.

test('releaseStaffSeat: credits the seat and re-snapshots head-count', async () => {
  const { releaseStaffSeat } = await import('../src/services/seatBillingService.js');
  const Subscription = (await import('../src/models/Subscription.js')).default;

  const subscription = {
    plan: { _id: 'plan-1', maxStaff: 20, monthlyPrice: 2000, extraStaffPrice: 100 },
    billingCycle: 'monthly',
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 15 * DAY_MS),
    staffCount: 4,
    seatAdjustments: [],
    save: async function () { this.saved = true; },
  };

  mock.method(Subscription, 'findOne', () => ({ populate: async () => subscription }));
  mock.method(User, 'countDocuments', async () => 3);

  await releaseStaffSeat({
    shopId: 'shop-1',
    staff: { _id: 'staff-1', name: 'Amina' },
    wasActive: true,
    reason: 'staff_account_closed',
  });

  assert.equal(subscription.staffCount, 3, 'the snapshot must follow reality');
  assert.ok(subscription.saved);
  // 'staff_account_closed' must be a valid enum value on the subschema, or the
  // save throws and the caller's catch swallows the whole credit.
  const reasons = Subscription.schema.path('seatAdjustments').schema.path('reason').enumValues;
  assert.ok(reasons.includes('staff_account_closed'), 'reason must be an accepted enum value');
});

test('releaseStaffSeat: an inactive account was never billable, so releases nothing', async () => {
  const { releaseStaffSeat } = await import('../src/services/seatBillingService.js');
  const Subscription = (await import('../src/models/Subscription.js')).default;
  const findOne = mock.method(Subscription, 'findOne', () => ({ populate: async () => null }));

  const result = await releaseStaffSeat({
    shopId: 'shop-1',
    staff: { _id: 'staff-1', name: 'Amina' },
    wasActive: false,
  });

  assert.equal(result, null);
  assert.equal(findOne.mock.callCount(), 0, 'no subscription lookup for a non-billable seat');
});

test('the credit a closure books validates against the real Subscription schema', async () => {
  // Deliberately not mocked. The seat-release bug this covers failed *inside*
  // Mongoose validation and was swallowed by the caller's catch, so a test
  // whose save() is a stub would have passed against the broken code. Building
  // a real document and validating it is the only version that would have
  // caught it — no database needed, validateSync is synchronous and local.
  const mongoose = (await import('mongoose')).default;
  const Subscription = (await import('../src/models/Subscription.js')).default;
  const { computeSeatChange } = await import('../src/services/seatBillingService.js');

  const subscription = new Subscription({
    shop: new mongoose.Types.ObjectId(),
    plan: new mongoose.Types.ObjectId(),
    status: 'active',
    billingCycle: 'monthly',
    currentPeriodEnd: new Date(Date.now() + 15 * DAY_MS),
    staffCount: 4,
  });

  // The same shape releaseStaffSeat books, via the same calculator.
  const change = computeSeatChange({
    plan: { maxStaff: 20, monthlyPrice: 2000, extraStaffPrice: 100 },
    subscription,
    fromCount: 4,
    toCount: 3,
  });
  subscription.seatAdjustments.push({
    ...change,
    reason: 'staff_account_closed',
    staffName: 'Amina',
    createdAt: new Date(),
  });

  assert.equal(subscription.validateSync(), undefined, 'the booked credit must be a valid subdocument');

  const booked = subscription.seatAdjustments[0];
  assert.equal(booked.reason, 'staff_account_closed');
  assert.ok(booked.proratedAmount <= 0, 'vacating a seat is a credit, never a charge');
});
