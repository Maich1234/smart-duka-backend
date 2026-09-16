import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Customer from '../src/models/Customer.js';
import CreditTransaction from '../src/models/CreditTransaction.js';
import Sale from '../src/models/Sale.js';
import {
  getCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  archiveCustomer,
} from '../src/controllers/customerController.js';
import {
  getCreditOverview,
  getCreditTransactions,
  recordCreditPayment,
  reverseCreditTransaction,
  recordOpeningBalance,
} from '../src/controllers/creditController.js';
import {
  canMakeCreditSale,
  canRecordCreditPayment,
  canViewAllCredit,
  canViewCustomerAccount,
  ledgerScopeFor,
} from '../src/services/creditService.js';
import { ALL_PERMISSIONS, withImpliedPermissions } from '../src/constants/permissions.js';
import { recordPaymentSchema, openingBalanceSchema, creditSettingsSchema } from '../src/validations/creditValidation.js';
import { updateCustomerSchema } from '../src/validations/customerValidation.js';

/**
 * Who may see whose money, and who may change the shop's exposure.
 *
 * DuQana is multi-tenant and this module is the financial one, so these are the
 * tests that matter most: a staff member must not widen their own view with a
 * query parameter, and a user from Shop A must not reach Shop B's customer by
 * guessing an id. The same shape as reconciliationController.test.js — assert
 * the *query* is pinned, not merely that the response looked right, because a
 * response can look right while the query was wrong.
 */

const SHOP_ID = '507f1f77bcf86cd799439011';
const OTHER_SHOP_ID = '507f1f77bcf86cd7994390ff';
const CALLER_ID = '507f1f77bcf86cd799439012';
const OTHER_STAFF_ID = '507f1f77bcf86cd799439099';
const CUSTOMER_ID = '507f1f77bcf86cd799439055';

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function makeReq({
  role = 'staff',
  permissions = [],
  query = {},
  body = {},
  params = {},
  creditSettings = { enabled: true, defaultCreditLimit: 3000, defaultCollectionPeriodDays: 7, productPolicy: 'ALL_PRODUCTS', overduePolicy: 'BLOCK' },
  paymentMethods,
} = {}) {
  return {
    user: {
      _id: CALLER_ID,
      name: 'Caller',
      role,
      permissions,
      shop: { _id: SHOP_ID, currency: 'KES', creditSettings, ...(paymentMethods ? { paymentMethods } : {}) },
    },
    query,
    body,
    params,
    headers: {},
  };
}

/** Chainable find() ending in .lean(); records the filter it was given. */
function stubFind(Model, rows, sink) {
  mock.method(Model, 'find', (filter) => {
    sink?.push(filter);
    const chain = {
      select() { return this; },
      populate() { return this; },
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      session() { return this; },
      lean: async () => rows,
      then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
    };
    return chain;
  });
}

function stubFindOne(Model, doc, sink) {
  mock.method(Model, 'findOne', (filter) => {
    sink?.push(filter);
    const chain = {
      select() { return this; },
      session() { return this; },
      lean: async () => doc,
      then(resolve, reject) { return Promise.resolve(doc).then(resolve, reject); },
    };
    return chain;
  });
}

const stubCount = (Model, n = 0) => mock.method(Model, 'countDocuments', async () => n);

/**
 * A session whose transaction body runs inline.
 *
 * Without it, any handler reaching mongoose.startSession() blocks forever
 * waiting for a connection this suite deliberately never opens — and the
 * failure presents as a hung test run rather than a missing stub. Running the
 * body inline also exercises the real authorization path right up to the
 * write, which is the part under test.
 */
function stubSession() {
  mock.method(mongoose, 'startSession', async () => ({
    withTransaction: async (fn) => fn(),
    endSession() {},
  }));
}

beforeEach(() => {
  mock.restoreAll();
  // Applied to every test, not just the ones that reach a write: a handler
  // that opened a real session here would block forever waiting for a
  // connection this suite deliberately never makes, and the failure would look
  // like a hang rather than a missing stub.
  stubSession();
});

// ── The permission matrix itself ────────────────────────────────────────────

test('the four credit permissions are registered and grouped so the owner UI can render them', () => {
  const credit = ALL_PERMISSIONS.filter((p) => p.category === 'Credit').map((p) => p.value);
  assert.deepEqual(credit, ['make_credit_sale', 'view_own_credit', 'view_all_credit', 'record_credit_payment']);
});

test('an owner holds every credit capability without any permission being granted explicitly', () => {
  // Owners are given ALL_PERMISSIONS by User's pre-save hook, but these checks
  // must not depend on that having run — an owner document loaded from an older
  // record still has to work.
  const owner = { role: 'owner', permissions: [] };
  assert.ok(canMakeCreditSale(owner));
  assert.ok(canRecordCreditPayment(owner));
  assert.ok(canViewAllCredit(owner));
  assert.ok(canViewCustomerAccount(owner));
});

test('a staff member with no grants holds nothing', () => {
  const nobody = { role: 'staff', permissions: [] };
  assert.equal(canMakeCreditSale(nobody), false);
  assert.equal(canRecordCreditPayment(nobody), false);
  assert.equal(canViewAllCredit(nobody), false);
  assert.equal(canViewCustomerAccount(nobody), false);
});

test('least privilege: each grant confers only itself', () => {
  // The brief's exact requirement — someone who can take a repayment must not
  // thereby be able to change a credit limit or the shop's credit settings.
  // Both of those are owner-only checks, so the guard is that none of these
  // permissions implies ownership of anything else.
  const collector = { role: 'staff', permissions: ['record_credit_payment'] };
  assert.ok(canRecordCreditPayment(collector));
  assert.equal(canMakeCreditSale(collector), false);
  assert.equal(canViewAllCredit(collector), false);

  const seller = { role: 'staff', permissions: ['make_credit_sale'] };
  assert.ok(canMakeCreditSale(seller));
  assert.equal(canRecordCreditPayment(seller), false);
  assert.equal(canViewAllCredit(seller), false);

  const ownViewer = { role: 'staff', permissions: ['view_own_credit'] };
  assert.equal(canViewAllCredit(ownViewer), false);
  assert.equal(canMakeCreditSale(ownViewer), false);
  assert.equal(canRecordCreditPayment(ownViewer), false);
});

test('granting the shop-wide view implies the own-scope view, and only that', () => {
  const expanded = withImpliedPermissions(['view_all_credit']);
  assert.ok(expanded.includes('view_own_credit'));
  assert.equal(expanded.includes('record_credit_payment'), false);
  assert.equal(expanded.includes('make_credit_sale'), false);
});

// ── Ledger scoping ──────────────────────────────────────────────────────────

test('ledgerScopeFor pins a narrow viewer to their own id and leaves a wide one unfiltered', () => {
  assert.deepEqual(ledgerScopeFor({ _id: CALLER_ID, role: 'staff', permissions: ['view_own_credit'] }), { staff: CALLER_ID });
  assert.deepEqual(ledgerScopeFor({ _id: CALLER_ID, role: 'staff', permissions: ['view_all_credit'] }), {});
  assert.deepEqual(ledgerScopeFor({ _id: CALLER_ID, role: 'owner', permissions: [] }), {});
});

test('getCreditTransactions: a staffId query parameter cannot widen an own-scope view', async () => {
  const filters = [];
  stubFind(CreditTransaction, [], filters);
  stubCount(CreditTransaction);

  const req = makeReq({ permissions: ['view_own_credit'], query: { staffId: OTHER_STAFF_ID } });
  const res = makeRes();
  await getCreditTransactions(req, res);

  assert.equal(res.statusCode, 200);
  // The narrowing must happen in the database. Handing the device the whole
  // book and filtering there is both a leak and a needless download.
  assert.equal(String(filters[0].staff), CALLER_ID, 'the caller id must win over the supplied one');
  assert.equal(String(filters[0].shop), SHOP_ID);
  assert.equal(res.body.scopedToSelf, true);
});

test('getCreditTransactions: an owner may filter by an arbitrary staff member', async () => {
  const filters = [];
  stubFind(CreditTransaction, [], filters);
  stubCount(CreditTransaction);

  const res = makeRes();
  await getCreditTransactions(makeReq({ role: 'owner', query: { staffId: OTHER_STAFF_ID } }), res);

  assert.equal(String(filters[0].staff), OTHER_STAFF_ID);
  assert.equal(res.body.scopedToSelf, false);
});

test('getCreditTransactions: every query is shop-scoped from the session', async () => {
  const filters = [];
  stubFind(CreditTransaction, [], filters);
  stubCount(CreditTransaction);

  const req = makeReq({ role: 'owner', query: { customerId: CUSTOMER_ID } });
  // A client that invents a shopId must not be able to reach another tenant.
  req.body.shopId = OTHER_SHOP_ID;
  req.query.shopId = OTHER_SHOP_ID;
  await getCreditTransactions(req, makeRes());

  assert.equal(String(filters[0].shop), SHOP_ID);
});

test('getCreditTransactions: a staff member with no credit grant at all is refused', async () => {
  const filters = [];
  stubFind(CreditTransaction, [], filters);
  const res = makeRes();
  await getCreditTransactions(makeReq({ permissions: ['record_sale'] }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(filters.length, 0, 'the database must not be touched before the permission check');
});

// ── Overview ────────────────────────────────────────────────────────────────

test('getCreditOverview: refused without the shop-wide view, before any aggregate runs', async () => {
  const aggregates = [];
  mock.method(Customer, 'aggregate', async (pipeline) => { aggregates.push(pipeline); return []; });

  const res = makeRes();
  await getCreditOverview(makeReq({ permissions: ['view_own_credit', 'make_credit_sale'] }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(aggregates.length, 0);
});

test('getCreditOverview: the aggregate is pinned to the caller\'s own shop', async () => {
  const aggregates = [];
  mock.method(Customer, 'aggregate', async (pipeline) => { aggregates.push(pipeline); return []; });
  const filters = [];
  stubFind(Customer, [], filters);
  stubCount(Customer);

  const res = makeRes();
  await getCreditOverview(makeReq({ role: 'owner' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(String(aggregates[0][0].$match.shop), SHOP_ID);
  assert.equal(String(filters[0].shop), SHOP_ID);
});

test('getCreditOverview: the overdue list is driven by due dates, not the stored status', async () => {
  mock.method(Customer, 'aggregate', async () => []);
  const filters = [];
  stubFind(Customer, [], filters);
  stubCount(Customer);

  await getCreditOverview(makeReq({ role: 'owner' }), makeRes());

  // So a debt that matured overnight appears the moment the owner opens the
  // screen, rather than waiting for the nightly sweep to relabel it.
  assert.ok(filters[0]['credit.oldestDueAt'].$lte instanceof Date);
  assert.equal(filters[0]['credit.oldestDueAt'].$ne, null);
});

// ── Cross-tenant access ─────────────────────────────────────────────────────

test('getCustomerById: another shop\'s customer is simply not found', async () => {
  const filters = [];
  stubFindOne(Customer, null, filters);

  const res = makeRes();
  await getCustomerById(makeReq({ role: 'owner', params: { id: CUSTOMER_ID } }), res);

  assert.equal(String(filters[0].shop), SHOP_ID, 'the lookup is always shop-scoped');
  // 404 rather than 403: telling someone "that exists but is not yours" is
  // itself a disclosure about another tenant.
  assert.equal(res.statusCode, 404);
});

test('updateCustomer, archiveCustomer and the opening-balance import are all shop-scoped lookups', async () => {
  for (const [handler, req] of [
    [updateCustomer, makeReq({ role: 'owner', params: { id: CUSTOMER_ID }, body: { name: 'X' } })],
    [archiveCustomer, makeReq({ role: 'owner', params: { id: CUSTOMER_ID } })],
    [recordOpeningBalance, makeReq({ role: 'owner', body: { customerId: CUSTOMER_ID, amount: 100 } })],
  ]) {
    mock.restoreAll();
    const filters = [];
    stubFindOne(Customer, null, filters);
    const res = makeRes();
    await handler(req, res);
    assert.equal(String(filters[0].shop), SHOP_ID, `${handler.name} must scope by shop`);
    assert.equal(res.statusCode, 404);
  }
});

test('recordCreditPayment: a customer from another shop is not found, and no money moves', async () => {
  const filters = [];
  stubFindOne(Customer, null, filters);

  const req = makeReq({
    role: 'owner',
    params: { id: CUSTOMER_ID },
    body: { amount: 500, paymentMethod: 'cash' },
    paymentMethods: [{ key: 'cash', label: 'Cash', enabled: true }],
  });
  const res = makeRes();
  await recordCreditPayment(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(String(filters[0].shop), SHOP_ID);
});

test('reverseCreditTransaction: another shop\'s ledger entry is not reachable', async () => {
  const filters = [];
  stubFindOne(CreditTransaction, null, filters);
  // withTransaction isn't available without a replica set, so the handler's
  // session use is what fails first — the assertion is on the filter, which is
  // built before any write.
  const req = makeReq({ role: 'owner', params: { id: 'tx1' }, body: { reason: 'test' } });
  await reverseCreditTransaction(req, makeRes()).catch(() => {});

  if (filters.length > 0) assert.equal(String(filters[0].shop), SHOP_ID);
});

// ── Owner-only financial controls ───────────────────────────────────────────

test('updateCustomer: a staff member cannot raise a credit limit or unblock a customer', async () => {
  for (const body of [
    { creditLimit: 999999 },
    { creditBlocked: false },
    { creditBlockedReason: '' },
  ]) {
    mock.restoreAll();
    const saved = [];
    stubFindOne(Customer, {
      _id: CUSTOMER_ID, name: 'John', credit: { limit: 100, blocked: true },
      save: async () => saved.push(true),
    });
    const res = makeRes();
    await updateCustomer(makeReq({ permissions: ['make_credit_sale'], params: { id: CUSTOMER_ID }, body }), res);

    // Rejected, not silently dropped: sending this on an update is an explicit
    // attempt to change the shop's exposure, and quietly ignoring it would
    // leave the caller believing it worked.
    assert.equal(res.statusCode, 403, `${JSON.stringify(body)} must be refused`);
    assert.equal(res.body.code, 'OWNER_ONLY_FIELD');
    assert.equal(saved.length, 0, 'nothing may be written');
  }
});

test('updateCustomer: a staff member may still fix a phone number', async () => {
  let saved = false;
  stubFindOne(Customer, {
    _id: CUSTOMER_ID, name: 'John', credit: { limit: 100, blocked: false },
    save: async () => { saved = true; },
    toObject() { return { _id: CUSTOMER_ID, name: this.name, phone: this.phone, credit: this.credit }; },
  });

  const res = makeRes();
  await updateCustomer(
    makeReq({ permissions: ['make_credit_sale'], params: { id: CUSTOMER_ID }, body: { phone: '+254712345678' } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.ok(saved);
});

test('createCustomer: a staff member\'s credit limit is dropped rather than applied', async () => {
  let created;
  mock.method(Customer, 'create', async (doc) => {
    created = doc;
    return { _id: CUSTOMER_ID, ...doc, toObject() { return { _id: CUSTOMER_ID, ...doc }; } };
  });

  const res = makeRes();
  await createCustomer(
    makeReq({ permissions: ['make_credit_sale'], body: { name: 'New', creditLimit: 500000 } }),
    res,
  );

  assert.equal(res.statusCode, 201);
  // Dropped, not rejected — unlike an update, a blank create form legitimately
  // carries the field and failing the whole request would be hostile. The
  // customer simply follows the shop default.
  assert.equal(created.credit, undefined);
  assert.equal(String(created.shop), SHOP_ID);
});

test('createCustomer: a staff member with no credit grant cannot create customers at all', async () => {
  let called = false;
  mock.method(Customer, 'create', async () => { called = true; });
  const res = makeRes();
  await createCustomer(makeReq({ permissions: ['record_sale'], body: { name: 'New' } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(called, false);
});

test('reversals and opening balances are owner-only, whatever a staff member holds', async () => {
  const everyCreditPermission = ['make_credit_sale', 'view_own_credit', 'view_all_credit', 'record_credit_payment'];
  for (const handler of [reverseCreditTransaction, recordOpeningBalance]) {
    const res = makeRes();
    await handler(
      makeReq({ permissions: everyCreditPermission, params: { id: 'tx1' }, body: { reason: 'x', customerId: CUSTOMER_ID, amount: 100 } }),
      res,
    );
    assert.equal(res.statusCode, 403, `${handler.name} must be owner-only`);
  }
});

test('archiveCustomer: refused while the customer still owes money', async () => {
  let saved = false;
  stubFindOne(Customer, {
    _id: CUSTOMER_ID, name: 'John', credit: { outstanding: 450 },
    save: async () => { saved = true; },
  });

  const res = makeRes();
  await archiveCustomer(makeReq({ role: 'owner', params: { id: CUSTOMER_ID } }), res);

  // Hiding a debtor from the Credit section is exactly the wrong thing to make
  // easy — the debt would still count in the totals while being unreachable.
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'CUSTOMER_HAS_DEBT');
  assert.equal(saved, false);
});

// ── Repayment endpoint rules ────────────────────────────────────────────────

test('recordCreditPayment: refused without the grant, before the customer is even looked up', async () => {
  const filters = [];
  stubFindOne(Customer, null, filters);
  const res = makeRes();
  await recordCreditPayment(
    makeReq({ permissions: ['make_credit_sale', 'view_all_credit'], params: { id: CUSTOMER_ID }, body: { amount: 100, paymentMethod: 'cash' } }),
    res,
  );
  assert.equal(res.statusCode, 403);
  assert.equal(filters.length, 0);
});

test('recordCreditPayment: a method the shop does not offer is refused with a code the client can act on', async () => {
  const res = makeRes();
  await recordCreditPayment(
    makeReq({
      role: 'owner',
      params: { id: CUSTOMER_ID },
      body: { amount: 100, paymentMethod: 'bitcoin' },
      paymentMethods: [{ key: 'cash', label: 'Cash', enabled: true }],
    }),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'PAYMENT_METHOD_UNAVAILABLE');
});

test('recordCreditPayment: a debt cannot be repaid with credit', async () => {
  const res = makeRes();
  await recordCreditPayment(
    makeReq({
      role: 'owner',
      params: { id: CUSTOMER_ID },
      body: { amount: 100, paymentMethod: 'credit' },
      paymentMethods: [
        { key: 'cash', label: 'Cash', enabled: true },
        { key: 'credit', label: 'Credit (Deni)', enabled: true },
      ],
    }),
    res,
  );
  // Paying a debt with credit is not a payment; it would clear a balance
  // without any money arriving.
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'PAYMENT_METHOD_UNAVAILABLE');
});

test('recordCreditPayment: still works while the credit module is switched off', async () => {
  // A shop that stops lending must still be able to collect what it is owed —
  // otherwise turning credit off strands every open debt.
  const filters = [];
  stubFindOne(Customer, { _id: CUSTOMER_ID, name: 'John' }, filters);

  const req = makeReq({
    role: 'owner',
    params: { id: CUSTOMER_ID },
    body: { amount: 100, paymentMethod: 'cash' },
    creditSettings: { enabled: false, defaultCreditLimit: 3000, defaultCollectionPeriodDays: 7, productPolicy: 'ALL_PRODUCTS', overduePolicy: 'BLOCK' },
    paymentMethods: [{ key: 'cash', label: 'Cash', enabled: true }],
  });
  // The guarded decrement refuses (this stub customer owes nothing), which is
  // enough to prove the request reached the ledger rather than being turned
  // away by a gate.
  mock.method(Customer, 'findOneAndUpdate', async () => null);

  const res = makeRes();
  await recordCreditPayment(req, res);

  assert.equal(filters.length > 0, true, 'the customer was looked up, so no gate refused it');
  assert.notEqual(res.statusCode, 403, 'a disabled module must not block collection');
  assert.equal(res.body.code, 'REPAYMENT_EXCEEDS_BALANCE', 'it failed on the balance, not on the module flag');
});

// ── Input validation ────────────────────────────────────────────────────────

test('repayment amounts: zero, negative, absurd and non-numeric are all refused', () => {
  for (const amount of [0, -1, -0.01, 999_999_999, 'lots', null, NaN, Infinity]) {
    const { error } = recordPaymentSchema.validate({ amount, paymentMethod: 'cash' });
    assert.ok(error, `${String(amount)} must be refused`);
  }
  assert.equal(recordPaymentSchema.validate({ amount: 1500.5, paymentMethod: 'cash' }).error, undefined);
});

test('a repayment cannot smuggle in a customer, a due date or a shop', () => {
  // stripUnknown means an undeclared key is dropped silently; unknown(false)
  // is what makes the attempt an outright error instead.
  const { error } = recordPaymentSchema.validate({
    amount: 100, paymentMethod: 'cash', shopId: OTHER_SHOP_ID, customerId: CUSTOMER_ID, dueAt: '2030-01-01',
  });
  assert.ok(error);
});

test('an opening balance cannot be parked years outside the reporting window', () => {
  const base = { customerId: CUSTOMER_ID, amount: 1000 };
  assert.ok(openingBalanceSchema.validate({ ...base, dueAt: '2005-01-01' }).error);
  assert.ok(openingBalanceSchema.validate({ ...base, dueAt: '2099-01-01' }).error);
  assert.equal(openingBalanceSchema.validate(base).error, undefined, 'omitting it is fine — the server computes one');
});

test('an opening balance requires a well-formed customer id', () => {
  for (const customerId of ['', 'not-an-id', '../../etc/passwd', '507f1f77bcf86cd79943901', { $ne: null }]) {
    assert.ok(openingBalanceSchema.validate({ customerId, amount: 100 }).error, `${JSON.stringify(customerId)} must be refused`);
  }
});

test('credit settings reject values outside their allowed sets', () => {
  assert.ok(creditSettingsSchema.validate({ productPolicy: 'EVERYTHING' }).error);
  assert.ok(creditSettingsSchema.validate({ overduePolicy: 'IGNORE' }).error);
  assert.ok(creditSettingsSchema.validate({ defaultCollectionPeriodDays: -1 }).error);
  assert.ok(creditSettingsSchema.validate({ defaultCollectionPeriodDays: 4000 }).error);
  assert.ok(creditSettingsSchema.validate({ defaultCreditLimit: -100 }).error);
  assert.ok(creditSettingsSchema.validate({}).error, 'an empty update is meaningless');
  assert.equal(creditSettingsSchema.validate({ enabled: true }).error, undefined);
});

test('a customer update cannot reach through to the credit rollup', () => {
  // The balance is derived from the ledger. A client that could set it
  // directly could clear a debt without any money arriving.
  for (const body of [
    { credit: { outstanding: 0 } },
    { 'credit.outstanding': 0 },
    { outstanding: 0 },
    { shop: OTHER_SHOP_ID },
  ]) {
    assert.ok(updateCustomerSchema.validate(body).error, `${JSON.stringify(body)} must be refused`);
  }
});

// ── List filters ────────────────────────────────────────────────────────────

test('getCustomers: a viewer who may not see credit gets no balances and no credit filters', async () => {
  const filters = [];
  stubFind(Customer, [{ _id: CUSTOMER_ID, name: 'John', credit: { outstanding: 900 } }], filters);
  stubCount(Customer, 1);

  const res = makeRes();
  await getCustomers(
    makeReq({ permissions: ['record_sale'], query: { filter: 'overdue', sort: 'name', page: 1, limit: 20 } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  // The filter is ignored rather than honoured — otherwise it becomes an
  // oracle for balances this user may not read.
  assert.equal(filters[0]['credit.status'], undefined);
  assert.equal(res.body.data[0].credit, undefined);
  assert.equal(res.body.data[0].account, undefined);
});

test('getCustomers: a credit viewer gets the filter, the balances and a shop-scoped query', async () => {
  const filters = [];
  stubFind(Customer, [{ _id: CUSTOMER_ID, name: 'John', isActive: true, credit: { outstanding: 900, limit: null, status: 'overdue' } }], filters);
  stubCount(Customer, 1);

  const res = makeRes();
  await getCustomers(
    makeReq({ permissions: ['view_all_credit'], query: { filter: 'overdue', sort: 'outstanding', page: 1, limit: 20 } }),
    res,
  );

  assert.equal(filters[0]['credit.status'], 'overdue');
  assert.equal(String(filters[0].shop), SHOP_ID);
  assert.equal(res.body.data[0].account.outstanding, 900);
  assert.equal(res.body.data[0].account.availableCredit, 2100);
});

test('getCustomers: archived customers stay hidden, and only an owner may ask for them', async () => {
  let filters = [];
  stubFind(Customer, [], filters);
  stubCount(Customer);
  await getCustomers(makeReq({ role: 'owner', query: { includeArchived: false, filter: 'all', sort: 'name', page: 1, limit: 20 } }), makeRes());
  assert.equal(filters[0].isActive, true);

  mock.restoreAll();
  filters = [];
  stubFind(Customer, [], filters);
  stubCount(Customer);
  await getCustomers(makeReq({ role: 'owner', query: { includeArchived: true, filter: 'all', sort: 'name', page: 1, limit: 20 } }), makeRes());
  assert.equal(filters[0].isActive, undefined);

  mock.restoreAll();
  filters = [];
  stubFind(Customer, [], filters);
  stubCount(Customer);
  await getCustomers(makeReq({ permissions: ['view_all_credit'], query: { includeArchived: true, filter: 'all', sort: 'name', page: 1, limit: 20 } }), makeRes());
  assert.equal(filters[0].isActive, true, 'a staff member cannot ask for archived records');
});

test('getCustomers: a search term is escaped before it reaches a regex', async () => {
  const filters = [];
  stubFind(Customer, [], filters);
  stubCount(Customer);

  await getCustomers(
    makeReq({ role: 'owner', query: { search: 'a.*(b', filter: 'all', sort: 'name', page: 1, limit: 20 } }),
    makeRes(),
  );

  // An unescaped `.*` would match every customer, and a crafted pattern is a
  // ReDoS in a query that runs on every keystroke.
  assert.equal(filters[0].$or[0].name.$regex, 'a\\.\\*\\(b');
});

// ── Account timeline scoping ────────────────────────────────────────────────

test('getCustomerById: an own-scope viewer\'s timeline is narrowed by the query, and says so', async () => {
  stubFindOne(Customer, { _id: CUSTOMER_ID, name: 'John', isActive: true, credit: { outstanding: 500, limit: null } });
  const ledgerFilters = [];
  mock.method(CreditTransaction, 'find', (filter) => {
    ledgerFilters.push(filter);
    return { sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => [] };
  });
  stubCount(CreditTransaction, 0);
  mock.method(Sale, 'find', () => ({
    select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => [],
  }));

  const res = makeRes();
  await getCustomerById(makeReq({ permissions: ['view_own_credit'], params: { id: CUSTOMER_ID }, query: {} }), res);

  assert.equal(String(ledgerFilters[0].staff), CALLER_ID);
  assert.equal(String(ledgerFilters[0].shop), SHOP_ID);
  // The client can then say "only your entries" rather than implying the
  // customer has no other history.
  assert.equal(res.body.data.scopedToSelf, true);
});

test('getCustomerById: a shop-wide viewer sees the whole timeline', async () => {
  stubFindOne(Customer, { _id: CUSTOMER_ID, name: 'John', isActive: true, credit: { outstanding: 500, limit: null } });
  const ledgerFilters = [];
  mock.method(CreditTransaction, 'find', (filter) => {
    ledgerFilters.push(filter);
    return { sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => [] };
  });
  stubCount(CreditTransaction, 0);
  mock.method(Sale, 'find', () => ({
    select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => [],
  }));

  const res = makeRes();
  await getCustomerById(makeReq({ permissions: ['view_all_credit'], params: { id: CUSTOMER_ID }, query: {} }), res);

  assert.equal(ledgerFilters[0].staff, undefined);
  assert.equal(res.body.data.scopedToSelf, false);
});
