import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Shop from '../src/models/Shop.js';
import User from '../src/models/User.js';
import AgentReferralCode from '../src/models/AgentReferralCode.js';
import resolveReferrer from '../src/utils/resolveReferrer.js';

// Shared by both the password-registration transaction and the new Google
// new-owner-signup transaction — extracted from register.js so the two
// never drift out of sync.

beforeEach(() => mock.restoreAll());

test('no code given resolves to no referrer', async () => {
  const result = await resolveReferrer('');
  assert.deepEqual(result, { referredByType: null, referredByShopId: null, referredByStaffId: null, referredByAgentId: null });
});

test('a shop code wins first', async () => {
  mock.method(Shop, 'findOne', () => ({ select: async () => ({ _id: 'shop-1' }) }));
  const result = await resolveReferrer('SHOPCODE');
  assert.equal(result.referredByType, 'shop');
  assert.equal(result.referredByShopId, 'shop-1');
});

test('falls through to a staff code when no shop matches', async () => {
  mock.method(Shop, 'findOne', () => ({ select: async () => null }));
  mock.method(User, 'findOne', () => ({ select: async () => ({ _id: 'staff-1' }) }));
  const result = await resolveReferrer('STAFFCODE');
  assert.equal(result.referredByType, 'staff');
  assert.equal(result.referredByStaffId, 'staff-1');
});

test('falls through to an agent code when neither shop nor staff match', async () => {
  mock.method(Shop, 'findOne', () => ({ select: async () => null }));
  mock.method(User, 'findOne', () => ({ select: async () => null }));
  mock.method(AgentReferralCode, 'findOne', () => ({ select: async () => ({ agentId: 'agent-1' }) }));
  const result = await resolveReferrer('AGENTCODE');
  assert.equal(result.referredByType, 'agent');
  assert.equal(result.referredByAgentId, 'agent-1');
});

test('an unknown code is a silent no-op, not an error', async () => {
  mock.method(Shop, 'findOne', () => ({ select: async () => null }));
  mock.method(User, 'findOne', () => ({ select: async () => null }));
  mock.method(AgentReferralCode, 'findOne', () => ({ select: async () => null }));
  const result = await resolveReferrer('NOTREAL');
  assert.equal(result.referredByType, null);
});
