import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveAccess, dueReminder } from '../src/services/subscriptionPricingService.js';

// Time-derived access states — pure date logic, no DB. All tests pin "now".

const NOW = new Date('2026-07-10T12:00:00Z');
const days = (n) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

test('no subscription → none (offer the trial)', () => {
  assert.equal(deriveAccess(null, 3, NOW).state, 'none');
});

test('subscription shell without dates → none', () => {
  const access = deriveAccess({ status: 'trialing', trialEnd: null, currentPeriodEnd: null }, 3, NOW);
  assert.equal(access.state, 'none');
});

test('inside the trial → trialing with days left', () => {
  const access = deriveAccess({ status: 'trialing', trialEnd: days(30) }, 3, NOW);
  assert.equal(access.state, 'trialing');
  assert.equal(access.daysLeft, 30);
});

test('trial expired 1 day ago, 3-day grace → grace with 2 days left', () => {
  const access = deriveAccess({ status: 'trialing', trialEnd: days(-1) }, 3, NOW);
  assert.equal(access.state, 'grace');
  assert.equal(access.graceDaysLeft, 2);
});

test('trial expired past grace → locked', () => {
  const access = deriveAccess({ status: 'trialing', trialEnd: days(-4) }, 3, NOW);
  assert.equal(access.state, 'locked');
});

test('zero grace days locks immediately at expiry', () => {
  const access = deriveAccess({ status: 'trialing', trialEnd: days(-0.5) }, 0, NOW);
  assert.equal(access.state, 'locked');
});

test('paid period in the future → active', () => {
  const access = deriveAccess({ status: 'active', trialEnd: days(-10), currentPeriodEnd: days(25) }, 3, NOW);
  assert.equal(access.state, 'active');
  assert.equal(access.daysLeft, 25);
});

test('paid period just ended → grace, then locked', () => {
  const sub = { status: 'active', trialEnd: days(-40), currentPeriodEnd: days(-2) };
  assert.equal(deriveAccess(sub, 3, NOW).state, 'grace');
  assert.equal(deriveAccess({ ...sub, currentPeriodEnd: days(-5) }, 3, NOW).state, 'locked');
});

test('cancelled keeps access until the paid period ends', () => {
  const access = deriveAccess({ status: 'cancelled', trialEnd: days(-40), currentPeriodEnd: days(10) }, 3, NOW);
  assert.equal(access.state, 'active');
  assert.equal(access.cancelled, true);
});

// ── Reminder windows ──────────────────────────────────────────────────────

const settings = { reminderDaysBefore: [7, 3], gracePeriodDays: 3 };

test('no reminder outside every window', () => {
  const sub = { status: 'trialing', trialEnd: days(20), remindersSent: [] };
  assert.equal(dueReminder(sub, settings, NOW), null);
});

test('T-7d window fires once, then dedupes', () => {
  const sub = { status: 'trialing', trialEnd: days(6.5), remindersSent: [] };
  const due = dueReminder(sub, settings, NOW);
  assert.equal(due.kind, 'expiry-7d');

  const again = dueReminder({ ...sub, remindersSent: [due.dedupeKey] }, settings, NOW);
  assert.equal(again, null);
});

test('T-3d window fires with its own key even after the 7d one', () => {
  const sevenDayKey = `expiry-7d:${days(2.5).toISOString().slice(0, 10)}`;
  const sub = { status: 'trialing', trialEnd: days(2.5), remindersSent: [sevenDayKey] };
  const due = dueReminder(sub, settings, NOW);
  assert.equal(due.kind, 'expiry-3d');
});

test('grace reminder fires once after expiry', () => {
  const sub = { status: 'trialing', trialEnd: days(-1), remindersSent: [] };
  const due = dueReminder(sub, settings, NOW);
  assert.equal(due.kind, 'grace');

  assert.equal(dueReminder({ ...sub, remindersSent: [due.dedupeKey] }, settings, NOW), null);
});

test('locked subscriptions get no more reminders', () => {
  const sub = { status: 'trialing', trialEnd: days(-10), remindersSent: [] };
  assert.equal(dueReminder(sub, settings, NOW), null);
});

test('a renewal moves the expiry date and re-arms every reminder', () => {
  const oldKeys = [
    `expiry-7d:${days(-2).toISOString().slice(0, 10)}`,
    `grace:${days(-2).toISOString().slice(0, 10)}`,
  ];
  // Paid: expiry now a month out; then approach the new T-7d window.
  const sub = { status: 'active', trialEnd: days(-2), currentPeriodEnd: days(6), remindersSent: oldKeys };
  const due = dueReminder(sub, settings, NOW);
  assert.equal(due.kind, 'expiry-7d');
  assert.notEqual(due.dedupeKey, oldKeys[0]);
});
