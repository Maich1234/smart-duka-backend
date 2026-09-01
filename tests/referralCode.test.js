import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeReferralCode, nextReferralCode } from '../src/utils/referralCode.js';

// A stand-in for ReferralCodeCounter that models findOneAndUpdate's
// atomicity the same way invoiceNumbering.test.js's fakeShopModel models
// findByIdAndUpdate — the increment and the read of the new value happen
// together, so interleaved callers cannot observe the same seq.
const fakeCounterModel = (seeds = {}) => {
  const counters = { ...seeds };
  return {
    counters,
    async findOneAndUpdate(filter, update, options) {
      const key = filter._id;
      if (!(key in counters) && !options?.upsert) return null;
      counters[key] = (counters[key] ?? 0) + update.$inc.seq;
      return { seq: counters[key] };
    },
  };
};

test('the 3rd character is always a digit', () => {
  for (let n = 0; n < 500; n += 1) {
    const code = encodeReferralCode('S', n);
    assert.equal(code.length, 6);
    assert.match(code[2], /[2-9]/);
  }
});

test('the code always starts with the given type character', () => {
  assert.equal(encodeReferralCode('S', 0)[0], 'S');
  assert.equal(encodeReferralCode('E', 0)[0], 'E');
  assert.equal(encodeReferralCode('A', 0)[0], 'A');
});

test('the alphabet excludes visually-ambiguous characters (0/O/1/I/L)', () => {
  for (let n = 0; n < 1000; n += 1) {
    const code = encodeReferralCode('S', n);
    assert.doesNotMatch(code, /[0OIL1]/);
  }
});

test('sequential n values never produce a duplicate code, within one type', () => {
  const seen = new Set();
  for (let n = 0; n < 20000; n += 1) {
    const code = encodeReferralCode('S', n);
    assert.equal(seen.has(code), false, `duplicate code ${code} at n=${n}`);
    seen.add(code);
  }
});

test('different type characters never collide, even for the same n', () => {
  for (let n = 0; n < 5000; n += 1) {
    const shop = encodeReferralCode('S', n);
    const staff = encodeReferralCode('E', n);
    const agent = encodeReferralCode('A', n);
    assert.notEqual(shop, staff);
    assert.notEqual(shop, agent);
    assert.notEqual(staff, agent);
  }
});

test('throws rather than silently truncating once the encoding space for a type is exhausted', () => {
  const CAPACITY = 31 ** 4 * 8; // 7,388,168
  assert.doesNotThrow(() => encodeReferralCode('S', CAPACITY - 1));
  assert.throws(() => encodeReferralCode('S', CAPACITY), /exhausted/);
});

test('nextReferralCode claims a fresh, format-compliant code via one atomic $inc', async () => {
  const Counter = fakeCounterModel({ shop_referral_code: 0 });
  const code = await nextReferralCode('S', 'shop_referral_code', { CounterModel: Counter });
  assert.equal(code[0], 'S');
  assert.match(code[2], /[2-9]/);
  assert.equal(Counter.counters.shop_referral_code, 1);
});

test('nextReferralCode never repeats across many sequential calls', async () => {
  const Counter = fakeCounterModel({ shop_referral_code: 0 });
  const codes = new Set();
  for (let i = 0; i < 1000; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const code = await nextReferralCode('S', 'shop_referral_code', { CounterModel: Counter });
    assert.equal(codes.has(code), false, `duplicate code ${code} on call ${i}`);
    codes.add(code);
  }
});

test('nextReferralCode never repeats under concurrent calls (Promise.all)', async () => {
  const Counter = fakeCounterModel({ shop_referral_code: 0 });
  const results = await Promise.all(
    Array.from({ length: 200 }, () => nextReferralCode('S', 'shop_referral_code', { CounterModel: Counter })),
  );
  assert.equal(new Set(results).size, results.length);
});

test('two different counter keys (shop vs staff) advance independently', async () => {
  const Counter = fakeCounterModel({ shop_referral_code: 0, staff_referral_code: 0 });
  const shopCode = await nextReferralCode('S', 'shop_referral_code', { CounterModel: Counter });
  const staffCode = await nextReferralCode('E', 'staff_referral_code', { CounterModel: Counter });
  assert.equal(shopCode, encodeReferralCode('S', 0));
  assert.equal(staffCode, encodeReferralCode('E', 0));
});
