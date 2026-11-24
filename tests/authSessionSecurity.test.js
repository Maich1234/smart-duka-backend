import assert from 'node:assert/strict';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import RefreshToken from '../src/models/RefreshToken.js';
import User from '../src/models/User.js';
import { protect } from '../src/middlewares/auth.js';
import { rotateRefreshToken } from '../src/services/refreshTokenService.js';
import { signQuotationToken, verifyQuotationToken } from '../src/utils/quotationToken.js';

test('refresh keeps the session ID when the database returns a commit result', async (t) => {
  const user = 'user-id';
  const sessionId = 'session-id';
  const transaction = { name: 'test transaction' };
  t.mock.method(RefreshToken.db, 'transaction', async (callback) => {
    await callback(transaction);
    return { ok: 1 };
  });
  t.mock.method(RefreshToken, 'findOneAndUpdate', async (_filter, _update, options) => {
    assert.equal(options.session, transaction);
    return { user, sessionId, deviceId: 'till' };
  });
  const create = t.mock.method(RefreshToken, 'create', async ([model], options) => {
    assert.equal(options.session, transaction);
    assert.equal(model.sessionId, sessionId);
    assert.equal(model.deviceId, 'till');
    assert.equal(model.user, user);
  });

  const rotation = await rotateRefreshToken('unit-test-refresh-token');
  assert.equal(rotation.sessionId, sessionId);
  assert.equal(rotation.userId, user);
  assert.match(rotation.refreshToken, /^[0-9a-f]{96}$/);
  assert.equal(create.mock.callCount(), 1);
});

test('a valid access JWT is rejected when its backing session was revoked', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'session-unit-test-key';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  t.mock.method(User, 'findById', () => ({
    select: () => ({ populate: async () => ({ _id: 'user-id', isActive: true }) }),
  }));
  t.mock.method(RefreshToken, 'exists', async (filter) => {
    assert.equal(filter.sessionId, 'revoked-session');
    assert.equal(filter.revokedAt, null);
    return null;
  });
  const token = jwt.sign({ id: 'user-id', sessionId: 'revoked-session' }, process.env.JWT_SECRET);
  const req = { headers: { authorization: 'Bearer ' + token } };
  const res = {
    status(code) {
      assert.equal(code, 401);
      return this;
    },
    json(body) {
      assert.equal(body.success, false);
      return body;
    },
  };
  assert.equal((await protect(req, res, () => assert.fail('Revoked session reached the route'))).success, false);
});

test('quotation links expire, including old signed links without an expiry', () => {
  const previousSecret = process.env.RECEIPT_TOKEN_SECRET;
  process.env.RECEIPT_TOKEN_SECRET = 'unit-test-signing-key';
  try {
    const token = signQuotationToken('quotation-id');
    const { iat, exp } = jwt.decode(token);
    assert.equal(exp - iat, 30 * 24 * 60 * 60);
    assert.equal(verifyQuotationToken(token), 'quotation-id');

    const legacy = jwt.sign({
      quotationId: 'quotation-id',
      iat: iat - 31 * 24 * 60 * 60,
    }, process.env.RECEIPT_TOKEN_SECRET);
    assert.equal(verifyQuotationToken(legacy), null);
  } finally {
    if (previousSecret === undefined) delete process.env.RECEIPT_TOKEN_SECRET;
    else process.env.RECEIPT_TOKEN_SECRET = previousSecret;
  }
});
