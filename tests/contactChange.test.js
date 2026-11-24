import assert from 'node:assert/strict';
import { test } from 'node:test';
import ContactChange from '../src/models/ContactChange.js';
import User from '../src/models/User.js';
import { requestContactChange } from '../src/controllers/auth/contactChange.js';
import { confirmContactChangeSchema, requestContactChangeSchema } from '../src/validations/authValidation.js';

test('contact change accepts only the selected destination format', () => {
  const email = requestContactChangeSchema.validate({ field: 'email', destination: ' SHOP@example.com ', currentPassword: 'test' });
  assert.equal(email.error, undefined);
  assert.equal(email.value.destination, 'shop@example.com');
  assert.ok(requestContactChangeSchema.validate({ field: 'phone', destination: 'shop@example.com', currentPassword: 'test' }).error);
  assert.equal(requestContactChangeSchema.validate({ field: 'phone', destination: '+254712345678', currentPassword: 'test' }).error, undefined);
});

test('a contact confirmation never accepts a replacement destination', () => {
  const result = confirmContactChangeSchema.validate({
    field: 'email', code: '123456', destination: 'replacement@example.com',
  }, { stripUnknown: true });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value, { field: 'email', code: '123456' });
});

test('a valid session alone cannot start a contact change', async (t) => {
  t.mock.method(User, 'findOne', async () => ({ comparePassword: async () => false }));
  const write = t.mock.method(ContactChange, 'updateOne', async () => assert.fail('No challenge should be issued'));
  const req = {
    user: { _id: 'user-id' },
    body: { field: 'email', destination: 'new@example.com', currentPassword: 'incorrect' },
  };
  const res = {
    status(code) {
      assert.equal(code, 400);
      return this;
    },
    json(body) {
      assert.equal(body.success, false);
    },
  };
  await requestContactChange(req, res);
  assert.equal(write.mock.callCount(), 0);
});
