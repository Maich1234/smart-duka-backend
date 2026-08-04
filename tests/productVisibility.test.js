import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForStaff, showsCommissionTo, previewFor, mergeVariantsForStaff } from '../src/services/productVisibility.js';

// This module is the boundary that decides what shop-margin data reaches a
// staff device. `costPrice` and `commission.basePrice` are both the owner's
// private numbers; a leak here is a leak on every product list the till loads.

const staff = (over = {}) => ({
  role: 'staff',
  commissionEligible: true,
  shop: { showStaffCommission: true },
  ...over,
});

const product = (over = {}) => ({
  _id: 'p1',
  name: 'Cooking Oil 2L',
  sellingPrice: 450,
  costPrice: 380,
  commission: { enabled: true, basePrice: 400, employeeSharePercent: 90 },
  ...over,
});

// --- Gating -----------------------------------------------------------------

test('gate: requires both the shop toggle and personal eligibility', () => {
  assert.equal(showsCommissionTo(staff()), true);
  assert.equal(showsCommissionTo(staff({ commissionEligible: false })), false);
  assert.equal(showsCommissionTo(staff({ shop: { showStaffCommission: false } })), false);
});

test('gate: a user with no shop populated is never shown commission', () => {
  assert.equal(showsCommissionTo({ role: 'staff', commissionEligible: true }), false);
  assert.equal(showsCommissionTo(undefined), false);
});

test('gate: eligibility must be exactly true, not merely truthy', () => {
  assert.equal(showsCommissionTo(staff({ commissionEligible: 'yes' })), false);
  assert.equal(showsCommissionTo(staff({ commissionEligible: 1 })), false);
});

// --- Leak prevention --------------------------------------------------------

test('leak: costPrice never survives sanitization', () => {
  const out = sanitizeForStaff(product(), true);
  assert.equal('costPrice' in out, false);
});

test('leak: the commission config never survives, even when previews are shown', () => {
  const out = sanitizeForStaff(product(), true);
  assert.equal('commission' in out, false);
  assert.equal(out.commissionPreview, 45);
});

test('leak: variant costPrice and commission config never survive', () => {
  const out = sanitizeForStaff(product({
    variants: [{
      _id: 'v1',
      name: '1L',
      sellingPrice: 250,
      costPrice: 200,
      commission: { enabled: true, basePrice: 200, employeeSharePercent: 50 },
    }],
  }), true);
  assert.equal('costPrice' in out.variants[0], false);
  assert.equal('commission' in out.variants[0], false);
  assert.equal(out.variants[0].commissionPreview, 25);
});

test('leak: the share percent is not published alongside the preview', () => {
  // Publishing both would make the floor recoverable as
  // sellingPrice − preview ÷ share, undoing the whole sanitization.
  const out = sanitizeForStaff(product(), true);
  const serialised = JSON.stringify(out);
  assert.equal(serialised.includes('employeeSharePercent'), false);
  assert.equal(serialised.includes('400'), false, 'the base price must not appear anywhere');
});

test('leak: commission is withheld entirely when the gate is closed', () => {
  const out = sanitizeForStaff(product(), false);
  assert.equal('commission' in out, false);
  assert.equal('commissionPreview' in out, false);
});

// --- Preview correctness ----------------------------------------------------
// The preview has to agree with what pricingEngine.js will actually pay out,
// or staff are quoted one number at the till and paid another.

test('preview: mirrors the sale-time formula', () => {
  assert.equal(previewFor({ enabled: true, basePrice: 400, employeeSharePercent: 90 }, 450), 45);
});

test('preview: defaults to the whole excess when no share is set', () => {
  assert.equal(previewFor({ enabled: true, basePrice: 400 }, 450), 50);
});

test('preview: is absent rather than zero when unconfigured', () => {
  assert.equal(previewFor(undefined, 450), undefined);
  assert.equal(previewFor({ enabled: false, basePrice: 400 }, 450), undefined);
  assert.equal(previewFor({ enabled: true }, 450), undefined);
});

test('preview: never goes negative below the floor', () => {
  assert.equal(previewFor({ enabled: true, basePrice: 400, employeeSharePercent: 90 }, 380), 0);
});

test('preview: a variant with no config inherits the parent product config', () => {
  const out = sanitizeForStaff(product({
    variants: [{ _id: 'v1', name: '1L', sellingPrice: 500, costPrice: 300 }],
  }), true);
  // Parent floor 400, 90% share, variant sells at 500 → 90.
  assert.equal(out.variants[0].commissionPreview, 90);
});

test('preview: a variant config overrides the parent product config', () => {
  const out = sanitizeForStaff(product({
    variants: [{
      _id: 'v1',
      name: '1L',
      sellingPrice: 500,
      commission: { enabled: true, basePrice: 300, employeeSharePercent: 50 },
    }],
  }), true);
  assert.equal(out.variants[0].commissionPreview, 100);
});

test('preview: an unconfigured product yields no preview field at all', () => {
  const out = sanitizeForStaff(product({ commission: undefined }), true);
  assert.equal('commissionPreview' in out, false);
});

// --- Who accrues commission -------------------------------------------------
// Mirrors the `earnsCommission` rule in controllers/saleController.js. Kept
// here as executable documentation of a rule that is easy to "fix" wrongly:
// commission is booked as a Staff commission operating expense in the P&L, so
// crediting an owner would deduct a wage the shop never actually pays.

const earnsCommission = (user) => user.role === 'staff' && user.commissionEligible === true;

test('accrual: an opted-in staff member earns commission', () => {
  assert.equal(earnsCommission({ role: 'staff', commissionEligible: true }), true);
});

test('accrual: a staff member who is not opted in earns nothing', () => {
  assert.equal(earnsCommission({ role: 'staff', commissionEligible: false }), false);
  assert.equal(earnsCommission({ role: 'staff' }), false);
});

test('accrual: an owner never accrues commission on their own sales', () => {
  // Would otherwise book a phantom "Staff commission" expense against the
  // owner's own profit — see services/books/profitLossService.js.
  assert.equal(earnsCommission({ role: 'owner', commissionEligible: true }), false);
  assert.equal(earnsCommission({ role: 'owner' }), false);
});

// --- Write boundary: what a staff edit may change ---------------------------
//
// A product update replaces the whole variant array, and staff are never sent
// costPrice or commission. Without the merge below, one staff edit would post
// blanks over the shop's margins on every variant.

const storedVariants = () => [
  {
    _id: 'v1',
    name: '500ml',
    sellingPrice: 120,
    costPrice: 90,
    quantity: 8,
    commission: { enabled: true, basePrice: 100, employeeSharePercent: 50 },
  },
  { _id: 'v2', name: '1L', sellingPrice: 200, costPrice: 150, quantity: 3 },
];

test('write: a staff edit keeps the stored cost and commission', () => {
  const merged = mergeVariantsForStaff(
    [{ _id: 'v1', name: '500ml', sellingPrice: 130, quantity: 12 }],
    storedVariants()
  );
  const v1 = merged.find((v) => String(v._id) === 'v1');
  assert.equal(v1.sellingPrice, 130, 'the price staff set is applied');
  assert.equal(v1.quantity, 12, 'the stock staff set is applied');
  assert.equal(v1.costPrice, 90, 'cost is carried over, not zeroed');
  assert.deepEqual(v1.commission, { enabled: true, basePrice: 100, employeeSharePercent: 50 });
});

test('write: a staff-supplied cost or commission cannot override the stored one', () => {
  const [v1] = mergeVariantsForStaff(
    [{ _id: 'v1', name: '500ml', sellingPrice: 120, costPrice: 0, commission: { enabled: false } }],
    storedVariants()
  );
  assert.equal(v1.costPrice, 90);
  assert.equal(v1.commission.enabled, true);
});

test('write: a variant staff omit is preserved, not deleted', () => {
  const merged = mergeVariantsForStaff(
    [{ _id: 'v1', name: '500ml', sellingPrice: 120 }],
    storedVariants()
  );
  assert.equal(merged.length, 2);
  assert.ok(merged.some((v) => String(v._id) === 'v2'), 'v2 survives being left out');
});

test('write: a new variant keeps its cost but never its commission', () => {
  const merged = mergeVariantsForStaff(
    [{ name: '2L', sellingPrice: 380, costPrice: 300, commission: { enabled: true, basePrice: 0 } }],
    storedVariants()
  );
  const added = merged.find((v) => v.name === '2L');
  assert.equal(added.costPrice, 300, 'staff supply the cost of a variant they are adding');
  assert.equal(added.commission, undefined, 'commission stays the owner’s call');
  assert.equal(added._id, undefined, 'no forged id');
});

test('write: identity is preserved so past sales keep pointing at the variant', () => {
  const [v1] = mergeVariantsForStaff([{ _id: 'v1', name: '500ml', sellingPrice: 120 }], storedVariants());
  assert.equal(String(v1._id), 'v1');
});

test('write: an absent variants key stays absent rather than wiping them', () => {
  assert.equal(mergeVariantsForStaff(undefined, storedVariants()), undefined);
});
