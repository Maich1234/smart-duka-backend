import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import PlatformConfigVerificationSession from '../src/models/PlatformConfigVerificationSession.js';
import {
  requestPlatformConfigVerification,
  verifyPlatformConfigCode,
  requirePlatformConfigVerification,
} from '../src/services/platformConfigVerificationService.js';

// requestPlatformConfigVerification's happy path sends real email (via
// utils/email.js's sendEmail, a plain function export rather than an
// object method, so it isn't mockable the way mpesaProvider.charge is in
// seatPayment.test.js) — same reason otpService.js's requestOTP has no
// happy-path test either. What's covered here is the fail-closed guard and
// all of verifyPlatformConfigCode/requirePlatformConfigVerification, which
// carry the actual security logic (lockout, expiry, admin binding).

process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret';

beforeEach(() => mock.restoreAll());

test('requestPlatformConfigVerification fails closed when no approver is configured', async () => {
  delete process.env.PLATFORM_CONFIG_APPROVER_EMAILS;
  await assert.rejects(
    requestPlatformConfigVerification({ _id: 'admin-1', name: 'A', email: 'a@x.com' }),
    (err) => {
      assert.match(err.message, /approver/i);
      assert.equal(err.statusCode, 500);
      return true;
    }
  );
});

test('verifyPlatformConfigCode: correct code issues a token scoped to the requesting admin', async () => {
  const otpHash = await bcrypt.hash('123456', 8);
  const session = {
    _id: 'sess-1',
    requestedByAdminId: 'admin-1',
    otpHash,
    expiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
    isUsed: false,
    save: async function () { return this; },
  };
  mock.method(PlatformConfigVerificationSession, 'findOne', async () => session);

  const token = await verifyPlatformConfigCode('sess-1', '123456', 'admin-1');
  const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);

  assert.equal(decoded.adminId, 'admin-1');
  assert.equal(decoded.purpose, 'platform_config');
  assert.equal(session.isUsed, true);
});

test('verifyPlatformConfigCode: wrong code increments attempts and locks out at 5', async () => {
  const otpHash = await bcrypt.hash('123456', 8);
  const session = {
    _id: 'sess-1',
    requestedByAdminId: 'admin-1',
    otpHash,
    expiresAt: new Date(Date.now() + 60_000),
    attempts: 4,
    isUsed: false,
    save: async function () { return this; },
  };
  mock.method(PlatformConfigVerificationSession, 'findOne', async () => session);

  await assert.rejects(verifyPlatformConfigCode('sess-1', '000000', 'admin-1'), /Incorrect code/);
  assert.equal(session.attempts, 5);

  // A 6th attempt (even with the right code) is now locked out.
  await assert.rejects(verifyPlatformConfigCode('sess-1', '123456', 'admin-1'), /Too many failed attempts/);
});

test('verifyPlatformConfigCode: expired session is rejected', async () => {
  const otpHash = await bcrypt.hash('123456', 8);
  mock.method(PlatformConfigVerificationSession, 'findOne', async () => ({
    _id: 'sess-1',
    requestedByAdminId: 'admin-1',
    otpHash,
    expiresAt: new Date(Date.now() - 1000),
    attempts: 0,
    isUsed: false,
    save: async function () { return this; },
  }));

  await assert.rejects(verifyPlatformConfigCode('sess-1', '123456', 'admin-1'), /expired/);
});

test('verifyPlatformConfigCode: a session requested by a different admin is not found', async () => {
  mock.method(PlatformConfigVerificationSession, 'findOne', async (filter) => {
    // Mirrors the real query's requestedByAdminId scoping.
    assert.equal(filter.requestedByAdminId, 'admin-2');
    return null;
  });

  await assert.rejects(verifyPlatformConfigCode('sess-1', '123456', 'admin-2'), /not found/);
});

function fakeReqRes(admin, headers = {}) {
  const req = { admin, headers };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { req, res };
}

test('requirePlatformConfigVerification: rejects when no token is present', () => {
  const { req, res } = fakeReqRes({ _id: 'admin-1' });
  let nextCalled = false;
  requirePlatformConfigVerification(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('requirePlatformConfigVerification: rejects a token minted for a different admin', () => {
  const token = jwt.sign({ adminId: 'admin-2', purpose: 'platform_config', type: 'admin' }, process.env.ADMIN_JWT_SECRET, { expiresIn: '10m' });
  const { req, res } = fakeReqRes({ _id: 'admin-1' }, { 'x-verification-token': token });
  let nextCalled = false;
  requirePlatformConfigVerification(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('requirePlatformConfigVerification: rejects a token with the wrong purpose (e.g. a shop-level payment_config token)', () => {
  const token = jwt.sign({ adminId: 'admin-1', purpose: 'payment_config', type: 'admin' }, process.env.ADMIN_JWT_SECRET, { expiresIn: '10m' });
  const { req, res } = fakeReqRes({ _id: 'admin-1' }, { 'x-verification-token': token });
  let nextCalled = false;
  requirePlatformConfigVerification(req, res, () => { nextCalled = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('requirePlatformConfigVerification: accepts a valid, correctly-scoped token', () => {
  const token = jwt.sign({ adminId: 'admin-1', purpose: 'platform_config', type: 'admin' }, process.env.ADMIN_JWT_SECRET, { expiresIn: '10m' });
  const { req, res } = fakeReqRes({ _id: 'admin-1' }, { 'x-verification-token': token });
  let nextCalled = false;
  requirePlatformConfigVerification(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.platformConfigVerification.adminId, 'admin-1');
});
