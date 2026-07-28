import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MONEY_OUT_METHODS, CASH_MOVING_METHODS } from '../src/constants/paymentMethods.js';
import { createExpenseSchema, updateExpenseSchema } from '../src/validations/expenseValidation.js';
import { createPurchaseSchema, updatePurchaseSchema } from '../src/validations/purchaseValidation.js';

// paymentMethod exists so the Cashbook can tell till cash from M-Pesa, and
// stock taken on account from stock paid for. See docs/business-books.md §0.2.

const expense = (over = {}) => ({ category: 'rent', amount: 5000, ...over });
const purchase = (over = {}) => ({
  items: [{ productId: '507f1f77bcf86cd799439011', quantity: 2, unitCost: 100 }],
  ...over,
});

test('credit is a money-out method but never a cash-moving one', () => {
  assert.ok(MONEY_OUT_METHODS.includes('credit'));
  assert.ok(!CASH_MOVING_METHODS.includes('credit'), 'nothing left the till on credit');
  assert.deepEqual(CASH_MOVING_METHODS, ['cash', 'mpesa', 'bank']);
});

test('money-out methods are not the same list as sale payment methods', () => {
  assert.ok(!MONEY_OUT_METHODS.includes('card'), 'card is money in, not money out');
  assert.ok(MONEY_OUT_METHODS.includes('bank'));
});

for (const method of MONEY_OUT_METHODS) {
  test(`expense accepts paymentMethod "${method}"`, () => {
    const { error, value } = createExpenseSchema.validate(expense({ paymentMethod: method }));
    assert.equal(error, undefined);
    assert.equal(value.paymentMethod, method);
  });

  test(`purchase accepts paymentMethod "${method}"`, () => {
    const { error, value } = createPurchaseSchema.validate(purchase({ paymentMethod: method }));
    assert.equal(error, undefined);
    assert.equal(value.paymentMethod, method);
  });
}

// These schemas are .unknown(false), so anything the client sends that the
// schema doesn't know about is a 400 — which cuts both ways. An older build,
// or a payload the mobile outbox queued before this field shipped, will omit
// paymentMethod entirely and must still be accepted.
test('expense without paymentMethod is still accepted (older client / queued payload)', () => {
  const { error, value } = createExpenseSchema.validate(expense());
  assert.equal(error, undefined);
  assert.equal(value.paymentMethod, undefined, 'left for the model to default to cash');
});

test('purchase without paymentMethod is still accepted (older client / queued payload)', () => {
  const { error } = createPurchaseSchema.validate(purchase());
  assert.equal(error, undefined);
});

test('an unrecognised payment method is rejected on both', () => {
  assert.ok(createExpenseSchema.validate(expense({ paymentMethod: 'barter' })).error);
  assert.ok(createPurchaseSchema.validate(purchase({ paymentMethod: 'barter' })).error);
  // 'card' is valid for a Sale but meaningless for money leaving the shop.
  assert.ok(createExpenseSchema.validate(expense({ paymentMethod: 'card' })).error);
});

test('updates may change payment method alone, without resending the record', () => {
  const expenseUpdate = updateExpenseSchema.validate({ paymentMethod: 'mpesa' });
  assert.equal(expenseUpdate.error, undefined);
  assert.equal(expenseUpdate.value.paymentMethod, 'mpesa');

  const purchaseUpdate = updatePurchaseSchema.validate({ paymentMethod: 'credit' });
  assert.equal(purchaseUpdate.error, undefined);
  assert.equal(purchaseUpdate.value.paymentMethod, 'credit');
});
