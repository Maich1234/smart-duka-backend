import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import User from '../src/models/User.js';
import { protect } from '../src/middlewares/auth.js';

process.env.JWT_SECRET ||= 'test-secret';
const ORIGINAL_ALLOWLIST = process.env.CORS_ALLOWED_ORIGINS;

beforeEach(() => {
  mock.restoreAll();
  delete process.env.CORS_ALLOWED_ORIGINS; // origin allowlist checks are covered separately in csrf.test.js
});
afterEach(() => {
  process.env.CORS_ALLOWED_ORIGINS = ORIGINAL_ALLOWLIST;
});

function mockUserLookup(user) {
  mock.method(User, 'findById', () => ({
    select: () => ({ populate: async () => user }),
  }));
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('protect: Bearer header still works exactly as before', async () => {
  const dbUser = { _id: 'user-1', role: 'owner', isActive: true, shop: { _id: 'shop-1' } };
  mockUserLookup(dbUser);
  const token = jwt.sign({ id: 'user-1' }, process.env.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} };
  const res = fakeRes();
  let nextCalled = false;

  await protect(req, res, () => { nextCalled = true; });

  assert.ok(nextCalled);
  assert.equal(req.user, dbUser);
});

test('protect: falls back to the access_token cookie when there is no Authorization header', async () => {
  const dbUser = { _id: 'user-1', role: 'owner', isActive: true, shop: { _id: 'shop-1' } };
  mockUserLookup(dbUser);
  const token = jwt.sign({ id: 'user-1' }, process.env.JWT_SECRET);
  const req = { headers: {}, method: 'GET', cookies: { access_token: token } };
  const res = fakeRes();
  let nextCalled = false;

  await protect(req, res, () => { nextCalled = true; });

  assert.ok(nextCalled);
  assert.equal(req.user, dbUser);
});

test('protect: no Authorization header and no cookie is rejected', async () => {
  const req = { headers: {}, cookies: {} };
  const res = fakeRes();
  let nextCalled = false;

  await protect(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('protect: extra claims stuffed into the JWT (role, shop) never reach req.user — only the DB row does', async () => {
  // Simulates a forged/tampered token trying to claim a privileged role or a
  // different shop. protect only ever uses decoded.id to look the user up;
  // req.user must reflect the real database row regardless of what else the
  // token's payload contains.
  const dbUser = { _id: 'user-1', role: 'staff', isActive: true, shop: { _id: 'real-shop' }, permissions: ['view_products'] };
  mockUserLookup(dbUser);
  const tamperedToken = jwt.sign({ id: 'user-1', role: 'owner', shop: 'attacker-shop', permissions: ['*'] }, process.env.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${tamperedToken}` }, cookies: {} };
  const res = fakeRes();

  await protect(req, res, () => {});

  assert.equal(req.user.role, 'staff', 'role must come from the database, never from the token payload');
  assert.equal(req.user.shop._id, 'real-shop', 'tenant must come from the database, never from the token payload');
});

test('protect: a cookie-authenticated mutating request without a matching CSRF header is rejected', async () => {
  const dbUser = { _id: 'user-1', role: 'owner', isActive: true, shop: { _id: 'shop-1' } };
  mockUserLookup(dbUser);
  const token = jwt.sign({ id: 'user-1' }, process.env.JWT_SECRET);
  const req = { headers: {}, method: 'POST', cookies: { access_token: token, csrf_token: 'secret' } };
  const res = fakeRes();
  let nextCalled = false;

  await protect(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false, 'CSRF gate must block this even though the session itself is valid');
  assert.equal(res.statusCode, 403);
});

test('protect: a cookie-authenticated mutating request WITH a matching CSRF header passes', async () => {
  const dbUser = { _id: 'user-1', role: 'owner', isActive: true, shop: { _id: 'shop-1' } };
  mockUserLookup(dbUser);
  const token = jwt.sign({ id: 'user-1' }, process.env.JWT_SECRET);
  const req = {
    headers: { 'x-csrf-token': 'secret' },
    method: 'POST',
    cookies: { access_token: token, csrf_token: 'secret' },
  };
  const res = fakeRes();
  let nextCalled = false;

  await protect(req, res, () => { nextCalled = true; });

  assert.ok(nextCalled);
});

test('protect: a Bearer-authenticated mutating request needs no CSRF header (mobile is exempt)', async () => {
  const dbUser = { _id: 'user-1', role: 'owner', isActive: true, shop: { _id: 'shop-1' } };
  mockUserLookup(dbUser);
  const token = jwt.sign({ id: 'user-1' }, process.env.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` }, method: 'POST', cookies: {} };
  const res = fakeRes();
  let nextCalled = false;

  await protect(req, res, () => { nextCalled = true; });

  assert.ok(nextCalled);
});

test('protect: a deactivated account is rejected even with a structurally valid token', async () => {
  const dbUser = { _id: 'user-1', role: 'owner', isActive: false, shop: { _id: 'shop-1' } };
  mockUserLookup(dbUser);
  const token = jwt.sign({ id: 'user-1' }, process.env.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} };
  const res = fakeRes();
  let nextCalled = false;

  await protect(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});
