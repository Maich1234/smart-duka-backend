import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireAllowedOrigin, verifyCsrf } from '../src/middlewares/csrf.js';

const ORIGINAL_ALLOWLIST = process.env.CORS_ALLOWED_ORIGINS;

beforeEach(() => {
  process.env.CORS_ALLOWED_ORIGINS = 'https://duqana.co.ke';
});
afterEach(() => {
  process.env.CORS_ALLOWED_ORIGINS = ORIGINAL_ALLOWLIST;
});

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('requireAllowedOrigin: allows a request from the allowlisted origin', () => {
  const req = { headers: { origin: 'https://duqana.co.ke' } };
  const res = fakeRes();
  let called = false;
  requireAllowedOrigin(req, res, () => { called = true; });
  assert.ok(called);
  assert.equal(res.statusCode, 200);
});

test('requireAllowedOrigin: rejects a cross-site origin (blocks login CSRF)', () => {
  const req = { headers: { origin: 'https://evil.example.com' } };
  const res = fakeRes();
  let called = false;
  requireAllowedOrigin(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('requireAllowedOrigin: allows a request with no Origin/Referer at all (native mobile client)', () => {
  const req = { headers: {} };
  const res = fakeRes();
  let called = false;
  requireAllowedOrigin(req, res, () => { called = true; });
  assert.ok(called, 'a native client that never sends Origin must not be blocked');
});

test('requireAllowedOrigin: no-ops when CORS_ALLOWED_ORIGINS is unset (local dev)', () => {
  delete process.env.CORS_ALLOWED_ORIGINS;
  const req = { headers: { origin: 'https://anything.example.com' } };
  const res = fakeRes();
  let called = false;
  requireAllowedOrigin(req, res, () => { called = true; });
  assert.ok(called);
});

test('verifyCsrf: Bearer-authenticated (mobile) requests are exempt', () => {
  const req = { method: 'POST', cookies: {}, headers: {} };
  const res = fakeRes();
  let called = false;
  verifyCsrf(req, res, () => { called = true; });
  assert.ok(called, 'no ambient cookie credential means nothing for a forged request to ride on');
});

test('verifyCsrf: cookie-authenticated GET requests are exempt (no state change)', () => {
  const req = { method: 'GET', cookies: { access_token: 'x' }, headers: {} };
  const res = fakeRes();
  let called = false;
  verifyCsrf(req, res, () => { called = true; });
  assert.ok(called);
});

test('verifyCsrf: cookie-authenticated mutating request with a matching header/cookie pair passes', () => {
  const req = {
    method: 'POST',
    cookies: { access_token: 'x', csrf_token: 'secret-123' },
    headers: { origin: 'https://duqana.co.ke', 'x-csrf-token': 'secret-123' },
  };
  const res = fakeRes();
  let called = false;
  verifyCsrf(req, res, () => { called = true; });
  assert.ok(called);
});

test('verifyCsrf: cookie-authenticated mutating request with a missing header is rejected', () => {
  const req = {
    method: 'POST',
    cookies: { access_token: 'x', csrf_token: 'secret-123' },
    headers: { origin: 'https://duqana.co.ke' },
  };
  const res = fakeRes();
  let called = false;
  verifyCsrf(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('verifyCsrf: cookie-authenticated mutating request with a mismatched header is rejected', () => {
  const req = {
    method: 'POST',
    cookies: { access_token: 'x', csrf_token: 'secret-123' },
    headers: { origin: 'https://duqana.co.ke', 'x-csrf-token': 'wrong-guess' },
  };
  const res = fakeRes();
  let called = false;
  verifyCsrf(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('verifyCsrf: a cross-site Origin is rejected even with a stolen-looking matching token pair', () => {
  // Defense in depth: an XSS bug elsewhere that lets an attacker read the
  // csrf_token cookie value still shouldn't let a cross-site page use it.
  const req = {
    method: 'POST',
    cookies: { access_token: 'x', csrf_token: 'secret-123' },
    headers: { origin: 'https://evil.example.com', 'x-csrf-token': 'secret-123' },
  };
  const res = fakeRes();
  let called = false;
  verifyCsrf(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});
