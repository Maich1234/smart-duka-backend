import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import User from '../src/models/User.js';
import OTP from '../src/models/OTP.js';
import { forgotPassword } from '../src/controllers/auth/password.js';

// Importing these registers mongoose schemas but never touches a DB; every
// static used below is mocked per-test, same convention as seatPayment.test.js.

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

beforeEach(() => mock.restoreAll());

test('forgotPassword: unknown email returns 404, no OTP created', async () => {
  mock.method(User, 'findOne', async () => null);
  const create = mock.method(OTP, 'create', async () => { throw new Error('must not be called'); });

  const req = { body: { email: 'nobody@shop.test' } };
  const res = makeRes();
  await forgotPassword(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(create.mock.callCount(), 0);
});

test('forgotPassword: a system-generated staff email (no real inbox) is rejected before an OTP is ever created', async () => {
  // This address has no real inbox behind it (see utils/staffEmailSlug.js) —
  // an OTP sent here can never be read, so the flow must fail fast with a
  // path forward instead of quietly creating an OTP no one can retrieve.
  mock.method(User, 'findOne', async () => ({ email: 'jane.otieno@joesshop.duqana.co.ke' }));
  const deleteMany = mock.method(OTP, 'deleteMany', async () => { throw new Error('must not be called'); });
  const create = mock.method(OTP, 'create', async () => { throw new Error('must not be called'); });

  const req = { body: { email: 'jane.otieno@joesshop.duqana.co.ke' } };
  const res = makeRes();
  await forgotPassword(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(deleteMany.mock.callCount(), 0);
  assert.equal(create.mock.callCount(), 0);
  const emailFieldError = res.body.fieldErrors.find((e) => e.field === 'email');
  assert.ok(emailFieldError, 'must surface as a field error so the client can render it under the email input');
  assert.match(emailFieldError.message, /shop owner/i);
});

test('forgotPassword: is case-insensitive when detecting a system-generated address', async () => {
  mock.method(User, 'findOne', async () => ({ email: 'Jane.Otieno@JoesShop.DUQANA.CO.KE' }));
  const create = mock.method(OTP, 'create', async () => { throw new Error('must not be called'); });

  const req = { body: { email: 'Jane.Otieno@JoesShop.DUQANA.CO.KE' } };
  const res = makeRes();
  await forgotPassword(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(create.mock.callCount(), 0);
});
