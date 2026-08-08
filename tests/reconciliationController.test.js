import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Shift from '../src/models/Shift.js';
import User from '../src/models/User.js';
import { getCashiers, getMonthly } from '../src/controllers/reconciliationController.js';

/**
 * Controller-level authorization tests — reconciliationService.test.js
 * already covers the aggregation math; this covers the part that's actually
 * risky to get wrong: who is allowed to see whose money, and whether a
 * tampered `staffId` query param can widen a staff member's own view.
 */

const SHOP_ID = '507f1f77bcf86cd799439011';
const CALLER_ID = '507f1f77bcf86cd799439012';
const OTHER_STAFF_ID = '507f1f77bcf86cd799439099';

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function makeReq({ role = 'staff', permissions = [], query = {}, shiftManagementEnabled = true } = {}) {
  return {
    user: {
      _id: CALLER_ID,
      role,
      permissions,
      shop: { _id: SHOP_ID, shiftManagementEnabled },
    },
    query,
  };
}

beforeEach(() => mock.restoreAll());

test('getCashiers: staff without view_reconciliation is rejected before touching the database', async () => {
  const aggregateCalls = [];
  mock.method(Shift, 'aggregate', async (pipeline) => { aggregateCalls.push(pipeline); return []; });

  const req = makeReq({ role: 'staff', permissions: [], query: {} });
  const res = makeRes();
  await getCashiers(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(aggregateCalls.length, 0, 'must not query Shift before the permission check');
});

test('getCashiers: a staffId query param cannot widen a staff member\'s own view', async () => {
  const matches = [];
  mock.method(Shift, 'aggregate', async (pipeline) => { matches.push(pipeline[0].$match); return []; });
  mock.method(User, 'find', () => ({ select: () => ({ lean: async () => [] }) }));

  const req = makeReq({
    role: 'staff',
    permissions: ['view_reconciliation'],
    query: { staffId: OTHER_STAFF_ID },
  });
  const res = makeRes();
  await getCashiers(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.enabled);
  // Both the closed-shift and active-shift $match stages must be pinned to
  // the caller's own id, never the id they tried to pass in.
  for (const match of matches) {
    assert.equal(String(match.staff), CALLER_ID);
  }
});

test('getCashiers: an owner may filter by an arbitrary staffId', async () => {
  const matches = [];
  mock.method(Shift, 'aggregate', async (pipeline) => { matches.push(pipeline[0].$match); return []; });
  mock.method(User, 'find', () => ({ select: () => ({ lean: async () => [] }) }));

  const req = makeReq({ role: 'owner', query: { staffId: OTHER_STAFF_ID } });
  const res = makeRes();
  await getCashiers(req, res);

  assert.equal(res.statusCode, 200);
  for (const match of matches) {
    assert.equal(String(match.staff), OTHER_STAFF_ID);
  }
});

test('getCashiers: owner with no staffId filter queries the whole shop, unscoped', async () => {
  const matches = [];
  mock.method(Shift, 'aggregate', async (pipeline) => { matches.push(pipeline[0].$match); return []; });
  mock.method(User, 'find', () => ({ select: () => ({ lean: async () => [] }) }));

  const req = makeReq({ role: 'owner', query: {} });
  const res = makeRes();
  await getCashiers(req, res);

  assert.equal(res.statusCode, 200);
  for (const match of matches) {
    assert.equal(match.staff, undefined);
  }
});

test('getCashiers: shift management off short-circuits before any Shift query, even for an owner', async () => {
  const aggregateCalls = [];
  mock.method(Shift, 'aggregate', async (pipeline) => { aggregateCalls.push(pipeline); return []; });

  const req = makeReq({ role: 'owner', shiftManagementEnabled: false });
  const res = makeRes();
  await getCashiers(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enabled, false);
  assert.deepEqual(res.body.data.cashiers, []);
  assert.equal(aggregateCalls.length, 0);
});

test('getMonthly: reports the whole shop with no staff-scoping branch', async () => {
  // Owner-only enforcement itself lives in the route's `ownerOnly` middleware
  // (see reconciliationRoutes.js), not here — this confirms the controller
  // carries no staffId-scoping logic that a future edit could inconsistently
  // add relative to /cashiers, since there's no legitimate single-staff view
  // of shop-wide P&L.
  const Sale = (await import('../src/models/Sale.js')).default;
  const Expense = (await import('../src/models/Expense.js')).default;
  const Purchase = (await import('../src/models/Purchase.js')).default;

  const matches = [];
  mock.method(Sale, 'aggregate', async (pipeline) => { matches.push(pipeline[0].$match); return []; });
  mock.method(Expense, 'aggregate', async (pipeline) => { matches.push(pipeline[0].$match); return []; });
  mock.method(Purchase, 'aggregate', async (pipeline) => { matches.push(pipeline[0].$match); return []; });

  // staffId here would only ever arrive if a future change loosened the
  // route's ownerOnly gate — the controller must ignore it regardless.
  const req = makeReq({ role: 'owner', query: { staffId: OTHER_STAFF_ID } });
  const res = makeRes();
  await getMonthly(req, res);

  assert.equal(res.statusCode, 200);
  for (const match of matches) {
    assert.equal(match.staff, undefined, 'getMonthly must never filter by staff');
    assert.equal(String(match.shop), SHOP_ID);
  }
});
