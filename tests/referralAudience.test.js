import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReferralAudienceActive } from '../src/utils/referralAudience.js';

const NOW = new Date('2026-08-12T12:00:00Z');
const PAST = new Date('2026-01-01T00:00:00Z');
const FUTURE = new Date('2026-12-31T00:00:00Z');

test('inactive when the audience is missing or falsy', () => {
  assert.equal(isReferralAudienceActive(null, NOW), false);
  assert.equal(isReferralAudienceActive(undefined, NOW), false);
});

test('inactive when enabled is false, regardless of dates', () => {
  assert.equal(isReferralAudienceActive({ enabled: false, startsAt: null, endsAt: null }, NOW), false);
});

test('active when enabled with no date window', () => {
  assert.equal(isReferralAudienceActive({ enabled: true, startsAt: null, endsAt: null }, NOW), true);
});

test('inactive before startsAt', () => {
  assert.equal(isReferralAudienceActive({ enabled: true, startsAt: FUTURE, endsAt: null }, NOW), false);
});

test('inactive after endsAt', () => {
  assert.equal(isReferralAudienceActive({ enabled: true, startsAt: null, endsAt: PAST }, NOW), false);
});

test('active when now falls within the window', () => {
  assert.equal(isReferralAudienceActive({ enabled: true, startsAt: PAST, endsAt: FUTURE }, NOW), true);
});
