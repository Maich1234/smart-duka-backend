import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSchema } from '../src/validations/authValidation.js';
import { CURRENT_TERMS_VERSION } from '../src/constants/legal.js';

const validBody = {
  name: 'Amina Wanjiru',
  email: 'amina@duka.co.ke',
  password: 'secret123',
  shopName: 'Duka Bora',
  acceptedTerms: true,
};

/**
 * The consent checkbox is only worth anything if the server refuses to create
 * an account without it — a client-side `disabled` button is a suggestion, not
 * a control.
 */

test('registerSchema: accepts a signup with consent given', () => {
  const { error, value } = registerSchema.validate(validBody);
  assert.equal(error, undefined);
  assert.equal(value.acceptedTerms, true);
});

test('registerSchema: rejects a signup with the box unticked', () => {
  const { error } = registerSchema.validate({ ...validBody, acceptedTerms: false });
  assert.ok(error, 'an unticked box must fail validation, not pass silently');
  assert.match(error.message, /Terms of Service and Privacy Policy/);
});

test('registerSchema: rejects a signup that omits consent entirely', () => {
  const body = { ...validBody };
  delete body.acceptedTerms;

  const { error } = registerSchema.validate(body);
  assert.ok(error, 'a client that just drops the field must not get an account');
  assert.match(error.message, /Terms of Service and Privacy Policy/);
});

test('registerSchema: a truthy non-true value does not count as consent', () => {
  // Guards against a client sending "true", 1, or "on" from a raw HTML form
  // and it being coerced into agreement nobody actually gave.
  for (const value of ['yes', 1, 'on', {}]) {
    const { error } = registerSchema.validate({ ...validBody, acceptedTerms: value });
    assert.ok(error, `${JSON.stringify(value)} must not be accepted as consent`);
  }
});

test('registerSchema: string "true" is accepted (Joi coerces it) but nothing else is', () => {
  // Joi coerces the canonical string form of a boolean; documented here so the
  // behaviour is deliberate rather than a surprise found later.
  const { error, value } = registerSchema.validate({ ...validBody, acceptedTerms: 'true' });
  assert.equal(error, undefined);
  assert.equal(value.acceptedTerms, true);
});

test('a terms version is defined, so stored consent is attributable', () => {
  assert.ok(CURRENT_TERMS_VERSION, 'consent with no version recorded proves little');
  assert.match(CURRENT_TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});
