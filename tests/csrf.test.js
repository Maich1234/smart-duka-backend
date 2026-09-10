import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireAllowedOrigin, verifyCsrf, isOriginAllowed } from '../src/middlewares/csrf.js';

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

test('requireAllowedOrigin: rejects a literal "Origin: null" header (opaque-origin browser request, not a native client)', () => {
  // Sandboxed iframes and data: URLs legitimately send the literal string
  // "null" as their Origin header. It's truthy, so it must not fall through
  // to the no-Origin-header "native client" allowance the way a genuinely
  // absent header does — that would reopen login-CSRF for a zero-click
  // fetch() fired from such an iframe.
  const req = { headers: { origin: 'null' } };
  const res = fakeRes();
  let called = false;
  requireAllowedOrigin(req, res, () => { called = true; });
  assert.equal(called, false, 'an opaque-origin browser request must be rejected, not treated as a native client');
  assert.equal(res.statusCode, 403);
});

test('requireAllowedOrigin: rejects an otherwise-unparseable Origin header the same way', () => {
  const req = { headers: { origin: 'not a url' } };
  const res = fakeRes();
  let called = false;
  requireAllowedOrigin(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('requireAllowedOrigin: no-ops when CORS_ALLOWED_ORIGINS is unset (local dev)', () => {
  delete process.env.CORS_ALLOWED_ORIGINS;
  const req = { headers: { origin: 'https://anything.example.com' } };
  const res = fakeRes();
  let called = false;
  requireAllowedOrigin(req, res, () => { called = true; });
  assert.ok(called);
});

test('requireAllowedOrigin: FAILS CLOSED when unset in production, for a browser-originated request', () => {
  delete process.env.CORS_ALLOWED_ORIGINS;
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const req = { headers: { origin: 'https://anything.example.com' } };
    const res = fakeRes();
    let called = false;
    requireAllowedOrigin(req, res, () => { called = true; });
    assert.equal(called, false, 'an unconfigured allowlist must not silently allow every origin in production');
    assert.equal(res.statusCode, 403);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test('requireAllowedOrigin: still allows a no-Origin request (native client) even when unset in production', () => {
  delete process.env.CORS_ALLOWED_ORIGINS;
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const req = { headers: {} };
    const res = fakeRes();
    let called = false;
    requireAllowedOrigin(req, res, () => { called = true; });
    assert.ok(called, 'the fail-closed behavior targets browser requests, not native/server-to-server callers');
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test('isOriginAllowed: this is what app.js\'s CORS setup calls directly — verify its production fail-closed behavior end to end', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.CORS_ALLOWED_ORIGINS;

    process.env.NODE_ENV = 'production';
    assert.equal(isOriginAllowed('https://evil.example.com'), false, 'an unconfigured allowlist must reject a browser origin in production');
    assert.equal(isOriginAllowed(undefined), true, 'no Origin header (mobile/server-to-server) is never a CORS concern');
    assert.equal(isOriginAllowed(''), true);

    process.env.NODE_ENV = 'development';
    assert.equal(isOriginAllowed('https://evil.example.com'), true, 'local dev keeps the permissive fallback');

    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://duqana.co.ke';
    assert.equal(isOriginAllowed('https://duqana.co.ke'), true);
    assert.equal(isOriginAllowed('https://evil.example.com'), false);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.CORS_ALLOWED_ORIGINS;
  }
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

test('verifyCsrf: a literal "Origin: null" is rejected even with a matching token pair', () => {
  const req = {
    method: 'POST',
    cookies: { access_token: 'x', csrf_token: 'secret-123' },
    headers: { origin: 'null', 'x-csrf-token': 'secret-123' },
  };
  const res = fakeRes();
  let called = false;
  verifyCsrf(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('verifyCsrf: FAILS CLOSED on a browser-originated mutating request when unset in production, even with a matching token pair', () => {
  delete process.env.CORS_ALLOWED_ORIGINS;
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const req = {
      method: 'POST',
      cookies: { access_token: 'x', csrf_token: 'secret-123' },
      headers: { origin: 'https://anything.example.com', 'x-csrf-token': 'secret-123' },
    };
    const res = fakeRes();
    let called = false;
    verifyCsrf(req, res, () => { called = true; });
    assert.equal(called, false, 'a matching double-submit pair must not paper over a missing allowlist in production');
    assert.equal(res.statusCode, 403);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
  }
});
