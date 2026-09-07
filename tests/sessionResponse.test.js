import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import RefreshToken from '../src/models/RefreshToken.js';
import {
  sendSessionCredentials,
  issueSessionResponse,
  setWebAccessOnlyCookie,
  clearSessionCookies,
} from '../src/services/sessionResponse.js';

// issueSessionResponse signs a real access token via generateToken(), which
// needs a secret — module scope runs once, before any test.
process.env.JWT_SECRET ||= 'test-secret';

beforeEach(() => mock.restoreAll());

function fakeRes() {
  const res = { cookies: {}, cleared: [], body: null };
  res.cookie = (name, value, options) => { res.cookies[name] = { value, options }; return res; };
  res.clearCookie = (name, options) => { res.cleared.push({ name, options }); return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('sendSessionCredentials: web gets HttpOnly cookies and no tokens in the body', () => {
  const res = fakeRes();
  sendSessionCredentials(res, { platform: 'web', accessToken: 'access-1', refreshToken: 'refresh-1', extra: { name: 'Amina' } });

  assert.equal(res.cookies.access_token.value, 'access-1');
  assert.equal(res.cookies.access_token.options.httpOnly, true);
  assert.equal(res.cookies.refresh_token.value, 'refresh-1');
  assert.equal(res.cookies.refresh_token.options.httpOnly, true);
  assert.ok(res.cookies.csrf_token.value, 'a csrf token must always be issued alongside a web session');
  assert.equal(res.cookies.csrf_token.options.httpOnly, false, 'the frontend must be able to read this one');

  assert.deepEqual(res.body, { success: true, data: { name: 'Amina' } });
  assert.equal(res.body.data.token, undefined, 'a real access token must never appear in the web response body');
  assert.equal(res.body.data.refreshToken, undefined, 'a real refresh token must never appear in the web response body');
});

test('sendSessionCredentials: mobile gets the token pair in the JSON body, no cookies', () => {
  const res = fakeRes();
  sendSessionCredentials(res, { platform: 'mobile', accessToken: 'access-1', refreshToken: 'refresh-1', extra: { name: 'Amina' } });

  assert.deepEqual(res.cookies, {});
  assert.deepEqual(res.body, { success: true, data: { name: 'Amina', token: 'access-1', refreshToken: 'refresh-1' } });
});

test('issueSessionResponse: mints exactly one refresh token, never two', async () => {
  let createCount = 0;
  mock.method(RefreshToken, 'create', async (doc) => { createCount += 1; return doc; });

  const res = fakeRes();
  await issueSessionResponse(res, { user: { _id: 'user-1' }, platform: 'web', device: { platform: 'web' } });

  assert.equal(createCount, 1, 'a fresh login must issue exactly one refresh token');
  assert.ok(res.cookies.refresh_token.value);
});

test('setWebAccessOnlyCookie: sets only access_token + csrf_token, never a refresh token', () => {
  const res = fakeRes();
  setWebAccessOnlyCookie(res, { accessToken: 'impersonation-jwt', maxAgeMs: 60000 });

  assert.equal(res.cookies.access_token.value, 'impersonation-jwt');
  assert.equal(res.cookies.access_token.options.maxAge, 60000);
  assert.ok(res.cookies.csrf_token.value, 'the impersonated session must still be able to make mutating requests');
  assert.equal(res.cookies.refresh_token, undefined, 'impersonation must never gain a renewable session');
});

test('clearSessionCookies: clears all three cookies', () => {
  const res = fakeRes();
  clearSessionCookies(res);
  const cleared = res.cleared.map((c) => c.name).sort();
  assert.deepEqual(cleared, ['access_token', 'csrf_token', 'refresh_token']);
});

test('in production, cookies default to SameSite=None + Secure (web and the API are cross-site — SameSite=Lax would never be sent)', async () => {
  const originalEnv = process.env.NODE_ENV;
  const originalSameSite = process.env.WEB_COOKIE_SAMESITE;
  process.env.NODE_ENV = 'production';
  delete process.env.WEB_COOKIE_SAMESITE;

  try {
    // Re-imported with a cache-busting query so the module's top-level
    // NODE_ENV/SAME_SITE constants are recomputed under this env.
    const mod = await import(`../src/services/sessionResponse.js?t=${Date.now()}`);
    const res = fakeRes();
    mod.sendSessionCredentials(res, { platform: 'web', accessToken: 'a', refreshToken: 'r' });

    assert.equal(res.cookies.access_token.options.sameSite, 'none');
    assert.equal(res.cookies.access_token.options.secure, true, 'SameSite=None is rejected by browsers without Secure');
  } finally {
    process.env.NODE_ENV = originalEnv;
    process.env.WEB_COOKIE_SAMESITE = originalSameSite;
  }
});
