import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import User from '../src/models/User.js';

// No database needed — validateSync runs schema validation synchronously
// and locally, same pattern as the existing Subscription validateSync test
// in accountDeletion.test.js.

test('a Google-linked owner needs no password', () => {
  const user = new User({
    name: 'Amina Wanjiru',
    email: 'amina@gmail.com',
    role: 'owner',
    shop: new mongoose.Types.ObjectId(),
    googleId: 'google-sub-123',
    authProviders: ['google'],
  });

  assert.equal(user.validateSync(), undefined, 'a Google-only account must not require a password');
});

test('an account with no password and no googleId still fails validation', () => {
  const user = new User({
    name: 'Amina Wanjiru',
    email: 'amina@duka.co.ke',
    role: 'owner',
    shop: new mongoose.Types.ObjectId(),
  });

  const error = user.validateSync();
  assert.ok(error, 'an account must have a password, a linked provider, or both — never neither');
  assert.ok(error.errors.password, 'the missing-credential error must be reported on the password field');
});

test('comparePassword on a Google-only account returns false instead of throwing', async () => {
  const user = new User({
    name: 'Amina Wanjiru',
    email: 'amina@gmail.com',
    role: 'owner',
    shop: new mongoose.Types.ObjectId(),
    googleId: 'google-sub-123',
    authProviders: ['google'],
  });

  const result = await user.comparePassword('whatever the attacker guesses');
  assert.equal(result, false);
});

test('two accounts cannot share a googleId (unique index declared on the schema path)', () => {
  const path = User.schema.path('googleId');
  assert.equal(path.options.unique, true);
  assert.equal(path.options.sparse, true, 'must be sparse so password-only accounts (no googleId) do not collide on null');
});
