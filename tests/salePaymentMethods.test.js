import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PAYMENT_METHODS,
  enabledMethodKeys,
  methodLabel,
  resolvePaymentMethods,
} from '../src/constants/salePaymentMethods.js';
import { computeShiftSummary } from '../src/services/shiftService.js';
import { createSaleSchema } from '../src/validations/saleValidation.js';
import { updateShopConfigSchema } from '../src/validations/shopValidation.js';

/* ── resolvePaymentMethods ──────────────────────────────────────────────── */

test('shops predating the setting fall back to Cash + M-PESA', () => {
  // Both shapes matter: a lean() read gives undefined, a hydrated doc gives [].
  for (const shop of [{}, { paymentMethods: [] }, { paymentMethods: null }, undefined]) {
    const methods = resolvePaymentMethods(shop);
    assert.deepEqual(methods.map((m) => m.key), ['cash', 'mpesa']);
  }
});

test('methods come back in the owner-chosen order, not insertion order', () => {
  const shop = {
    paymentMethods: [
      { key: 'airtel_money', label: 'Airtel Money', enabled: true, order: 2 },
      { key: 'cash', label: 'Cash', enabled: true, order: 0 },
      { key: 'mpesa', label: 'M-PESA', enabled: true, order: 1 },
    ],
  };
  assert.deepEqual(resolvePaymentMethods(shop).map((m) => m.key), ['cash', 'mpesa', 'airtel_money']);
});

test('disabled methods are not sellable but stay readable', () => {
  const shop = {
    paymentMethods: [
      { key: 'cash', label: 'Cash', enabled: true, order: 0 },
      { key: 'card', label: 'Card', enabled: false, order: 1 },
    ],
  };
  assert.deepEqual(enabledMethodKeys(shop), ['cash']);
  // The label still resolves, so an old card sale doesn't lose its name.
  assert.equal(methodLabel(shop, 'card'), 'Card');
});

test('an unknown key still produces a readable label', () => {
  // A method deleted after the sale was recorded.
  assert.equal(methodLabel({}, 'airtel_money'), 'Airtel Money');
});

test('M-Pesa is sellable by default, with no credentials anywhere in sight', () => {
  // The whole point: an unconfigured shop can take M-Pesa out of the box.
  assert.ok(enabledMethodKeys({}).includes('mpesa'));
  assert.ok(DEFAULT_PAYMENT_METHODS.every((m) => m.enabled));
});

/* ── Shift reconciliation ───────────────────────────────────────────────── */

test('shop-defined methods reach the shift summary instead of vanishing', () => {
  const s = computeShiftSummary({
    openingFloat: 0,
    sales: [
      { totalAmount: 100, paymentMethod: 'cash', status: 'completed', items: [] },
      { totalAmount: 250, paymentMethod: 'airtel_money', paymentMethodLabel: 'Airtel Money', status: 'completed', items: [] },
      { totalAmount: 400, paymentMethod: 'bank', paymentMethodLabel: 'Bank Transfer', status: 'completed', items: [] },
    ],
  });
  assert.equal(s.grossSales, 750);
  assert.equal(s.byMethod.airtel_money.total, 250);
  assert.equal(s.byMethod.airtel_money.label, 'Airtel Money');
  assert.equal(s.byMethod.bank.total, 400);
  // Only physical cash reconciles against the drawer.
  assert.equal(s.expectedCash, 100);
  // Legacy keys stay present so older clients keep rendering.
  assert.deepEqual(s.byMethod.card, { count: 0, total: 0 });
});

/* ── Validation ─────────────────────────────────────────────────────────── */

test('a sale accepts any well-formed method key (the shop decides the rest)', () => {
  const { error, value } = createSaleSchema.validate({
    items: [{ productId: 'p1', quantity: 1 }],
    paymentMethod: 'Airtel_Money',
  });
  assert.equal(error, undefined);
  assert.equal(value.paymentMethod, 'airtel_money');
});

test('a sale rejects a malformed method key', () => {
  for (const bad of ['', 'a', 'has spaces', 'Has-Dashes', 'x'.repeat(25)]) {
    const { error } = createSaleSchema.validate({
      items: [{ productId: 'p1', quantity: 1 }],
      paymentMethod: bad,
    });
    assert.ok(error, `expected '${bad}' to be rejected`);
  }
});

test('an M-Pesa sale needs no transaction and no receipt code', () => {
  // Shops on a Pochi or a personal number have neither, and must still sell.
  const { error } = createSaleSchema.validate({
    items: [{ productId: 'p1', quantity: 1 }],
    paymentMethod: 'mpesa',
  });
  assert.equal(error, undefined);
});

test('the till cannot be left with nothing to sell with', () => {
  const { error } = updateShopConfigSchema.validate({
    paymentMethods: [{ key: 'cash', label: 'Cash', enabled: false }],
  });
  assert.match(error.message, /at least one payment method/i);
});

test('duplicate method keys are rejected', () => {
  const { error } = updateShopConfigSchema.validate({
    paymentMethods: [
      { key: 'cash', label: 'Cash' },
      { key: 'cash', label: 'Cash Again' },
    ],
  });
  assert.match(error.message, /unique key/i);
});

test('a valid button list survives validation with defaults filled in', () => {
  const { error, value } = updateShopConfigSchema.validate({
    paymentMethods: [
      { key: 'cash', label: 'Cash', icon: 'cash' },
      { key: 'airtel_money', label: 'Airtel Money', icon: 'phone' },
    ],
  });
  assert.equal(error, undefined);
  assert.equal(value.paymentMethods[1].enabled, true);
});
