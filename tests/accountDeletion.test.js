import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import User from '../src/models/User.js';
import {
  deleteAccount,
  cancelAccountDeletion,
  previewAccountDeletion,
  DELETION_GRACE_DAYS,
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
