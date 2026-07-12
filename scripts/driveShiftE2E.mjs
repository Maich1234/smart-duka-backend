// End-to-end HTTP drive of the shift-management lifecycle against the local
// test backend. Exercises: feature flag off/on, sale gating, start/end shift,
// reconciliation math over real data, owner reports, daily summary + cron.
const BASE = 'http://127.0.0.1:5057/api/v1';
const PRODUCT_ID = process.argv[2];
if (!PRODUCT_ID) throw new Error('usage: node driveShiftE2E.mjs <productId>');

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
};

// ── logins ──────────────────────────────────────────────────────────────────
const ownerLogin = await call('POST', '/auth/login', { body: { email: 'owner@test.com', password: 'Password1' } });
const staffLogin = await call('POST', '/auth/login', { body: { email: 'staff@test.com', password: 'Password1' } });
const owner = ownerLogin.json?.data?.token ?? ownerLogin.json?.token;
const staff = staffLogin.json?.data?.token ?? staffLogin.json?.token;
check('owner + staff can log in', !!owner && !!staff, JSON.stringify(ownerLogin.json).slice(0, 200));

// ── feature off: everything works as before ────────────────────────────────
const active0 = await call('GET', '/shifts/active', { token: staff });
check('feature flag reported off by default', active0.json?.enabled === false && active0.json?.data === null);

const sale0 = await call('POST', '/sales', { token: staff, body: { items: [{ productId: PRODUCT_ID, quantity: 1 }], paymentMethod: 'cash' } });
check('sale succeeds with feature OFF (backward compat)', sale0.status === 201 && !sale0.json?.data?.shift, `status ${sale0.status}`);

const startOff = await call('POST', '/shifts/start', { token: staff, body: { openingFloat: 100 } });
check('cannot start a shift while feature is off', startOff.status === 400);

// ── owner flips the flag on ─────────────────────────────────────────────────
const toggle = await call('PUT', '/shop', { token: owner, body: { shiftManagementEnabled: true } });
check('owner enables shift management via shop config', toggle.status === 200 && toggle.json?.data?.shiftManagementEnabled === true);

const staffToggle = await call('PUT', '/shop', { token: staff, body: { shiftManagementEnabled: false } });
check('staff cannot flip the flag (owner only)', staffToggle.status === 403);

// ── gating ──────────────────────────────────────────────────────────────────
const gated = await call('POST', '/sales', { token: staff, body: { items: [{ productId: PRODUCT_ID, quantity: 1 }], paymentMethod: 'cash' } });
check('staff sale is blocked without an active shift', gated.status === 403 && gated.json?.code === 'SHIFT_REQUIRED', `status ${gated.status} ${JSON.stringify(gated.json).slice(0, 120)}`);

// ── start shift ─────────────────────────────────────────────────────────────
const start = await call('POST', '/shifts/start', { token: staff, body: { openingFloat: 1000, openingNote: 'Till 1', device: { platform: 'e2e', name: 'test-rig' } } });
check('shift starts with opening float', start.status === 201 && start.json?.data?.openingFloat === 1000);
const shiftId = start.json?.data?._id;

const startAgain = await call('POST', '/shifts/start', { token: staff, body: { openingFloat: 5 } });
check('second start is rejected (no overlapping shifts)', startAgain.status === 409 && startAgain.json?.code === 'SHIFT_ALREADY_ACTIVE');

// ── activity during the shift ───────────────────────────────────────────────
const sale1 = await call('POST', '/sales', { token: staff, body: { items: [{ productId: PRODUCT_ID, quantity: 2 }], paymentMethod: 'cash' } });
check('cash sale (2 × 65) records and links to the shift', sale1.status === 201 && sale1.json?.data?.shift === shiftId, JSON.stringify(sale1.json).slice(0, 150));

const expense = await call('POST', '/expenses', { token: staff, body: { category: 'supplies', amount: 50, description: 'Till paper' } });
check('expense records and links to the shift', expense.status === 201 && expense.json?.data?.shift === shiftId);

const stockAdj = await call('PATCH', `/products/${PRODUCT_ID}/stock`, { token: staff, body: { quantity: 95 } });
check('stock adjustment recorded', stockAdj.status === 200);

const activeNow = await call('GET', '/shifts/active', { token: staff });
check('active shift is visible to the till', activeNow.json?.data?._id === shiftId && activeNow.json?.enabled === true);

const preview = await call('GET', `/shifts/${shiftId}`, { token: staff });
check(
  'live summary previews expected cash before close (1000 + 130 − 50 = 1080)',
  preview.json?.liveSummary?.expectedCash === 1080,
  `got ${preview.json?.liveSummary?.expectedCash}`
);
check('live summary counts the stock adjustment', preview.json?.liveSummary?.stockAdjustments === 1, `got ${preview.json?.liveSummary?.stockAdjustments}`);

// ── end shift ────────────────────────────────────────────────────────────────
const end = await call('POST', '/shifts/current/end', { token: staff, body: { closingCount: 1075, closingNote: 'Handed over to Joy' } });
const summary = end.json?.data?.summary;
check('shift closes with a reconciliation snapshot', end.status === 200 && end.json?.data?.status === 'closed');
check('summary: 1 sale, gross 130', summary?.salesCount === 1 && summary?.grossSales === 130, JSON.stringify(summary)?.slice(0, 200));
check('summary: cash method total 130', summary?.byMethod?.cash?.total === 130);
check('summary: cash expenses 50', summary?.cashExpenses?.total === 50);
check('summary: expected cash 1080', summary?.expectedCash === 1080, `got ${summary?.expectedCash}`);
check('summary: drawer short by 5 (1075 − 1080)', summary?.cashDiscrepancy === -5, `got ${summary?.cashDiscrepancy}`);

const endAgain = await call('POST', `/shifts/${shiftId}/end`, { token: staff, body: { closingCount: 999 } });
check('re-closing is idempotent (returns existing report, no recompute)', endAgain.status === 200 && endAgain.json?.data?.summary?.cashDiscrepancy === -5);

const saleAfter = await call('POST', '/sales', { token: staff, body: { items: [{ productId: PRODUCT_ID, quantity: 1 }], paymentMethod: 'cash' } });
check('selling is locked again after clock-out', saleAfter.status === 403 && saleAfter.json?.code === 'SHIFT_REQUIRED');

// ── owner exemption ──────────────────────────────────────────────────────────
const ownerSale = await call('POST', '/sales', { token: owner, body: { items: [{ productId: PRODUCT_ID, quantity: 1 }], paymentMethod: 'mpesa', mpesaReceiptNumber: 'TESTRCPT01' } });
check('owner can sell without a shift (exempt from gate)', ownerSale.status === 201 && !ownerSale.json?.data?.shift, `status ${ownerSale.status} ${JSON.stringify(ownerSale.json).slice(0, 120)}`);

// ── owner reporting ──────────────────────────────────────────────────────────
const list = await call('GET', '/shifts', { token: owner });
check('owner sees the shift in the shop list', list.json?.data?.some?.((s) => s._id === shiftId) === true);

const staffList = await call('GET', '/shifts', { token: staff });
check('staff list is scoped to their own shifts', staffList.json?.data?.every?.((s) => (typeof s.staff === 'object' ? s.staff._id : s.staff) === (typeof list.json.data.find(x => x._id === shiftId).staff === 'object' ? list.json.data.find(x => x._id === shiftId).staff._id : list.json.data.find(x => x._id === shiftId).staff)) === true);

const daily = await call('GET', '/summaries/daily/today', { token: owner });
const totals = daily.json?.data?.totals;
check('daily summary compiles (owner)', daily.status === 200 && !!totals);
// Day revenue: pre-flag sale 65 + shift sale 130 + owner sale 65 = 260
check('daily summary revenue covers all of today (260)', totals?.revenue === 260, `got ${totals?.revenue}`);
check('daily summary sees 1 closed shift with −5 discrepancy', daily.json?.data?.shifts?.count === 1 && daily.json?.data?.shifts?.totalDiscrepancy === -5, JSON.stringify(daily.json?.data?.shifts));
check('daily summary est. gross profit (260 − 4×45 = 80)', totals?.grossProfit === 80, `got ${totals?.grossProfit}`);
check('daily summary has insights', (daily.json?.data?.insights?.length ?? 0) > 0);

const dailyAsStaff = await call('GET', '/summaries/daily/today', { token: staff });
check('daily summary is owner-only', dailyAsStaff.status === 403);

// ── cron ─────────────────────────────────────────────────────────────────────
const cronNoAuth = await call('GET', '/cron/daily-summary');
check('cron rejects missing secret', cronNoAuth.status === 401);
const cron = await call('GET', '/cron/daily-summary', { token: 'testcron' });
check('cron compiles summaries for flag-enabled shops', cron.status === 200 && cron.json?.processed === 1, JSON.stringify(cron.json).slice(0, 150));

console.log(failures === 0 ? '\n🎉 ALL CHECKS PASSED' : `\n💥 ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
