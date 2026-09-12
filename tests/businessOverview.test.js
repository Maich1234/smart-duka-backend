import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Product from '../src/models/Product.js';
import Asset, { assetUnitValue } from '../src/models/Asset.js';
import { shapeValuation, stockValueExpression } from '../src/services/inventoryValuationService.js';
import {
  resolveOverviewRange,
  buildTrendBuckets,
  getCapitalPosition,
  getProductPerformance,
  MAX_CUSTOM_RANGE_DAYS,
  PRODUCT_SORT_KEYS,
} from '../src/services/businessOverviewService.js';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => mock.restoreAll());

// ── Period windows ──────────────────────────────────────────────────────────

test('range: a month window is half-open — first of the month to first of the next', () => {
  const { start, end } = resolveOverviewRange({ period: 'month' });
  assert.equal(start.getUTCDate(), 1);
  assert.equal(start.getUTCHours(), 0);
  assert.equal(end.getUTCDate(), 1);
  assert.equal(end.getUTCMonth(), (start.getUTCMonth() + 1) % 12);
});

test('range: last_month never collides with this month', () => {
  const thisMonth = resolveOverviewRange({ period: 'month' });
  const lastMonth = resolveOverviewRange({ period: 'last_month' });
  assert.equal(lastMonth.end.getTime(), thisMonth.start.getTime());
  assert.ok(lastMonth.start < lastMonth.end);
});

test('range: a custom period needs both ends', () => {
  assert.throws(
    () => resolveOverviewRange({ period: 'custom', startDate: '2026-09-01' }),
    (err) => err.status === 400,
  );
});

test('range: a custom period is inclusive of its end date', () => {
  const { start, end } = resolveOverviewRange({
    period: 'custom', startDate: '2026-09-01', endDate: '2026-09-30',
  });
  // 30 whole days — an exclusive end would silently drop the 30th's sales.
  assert.equal((end - start) / DAY, 30);
});

test('range: a backwards custom period is refused, not silently emptied', () => {
  assert.throws(
    () => resolveOverviewRange({ period: 'custom', startDate: '2026-09-30', endDate: '2026-09-01' }),
    (err) => err.status === 400,
  );
});

test('range: an oversized custom period is refused rather than served slowly', () => {
  assert.throws(
    () => resolveOverviewRange({ period: 'custom', startDate: '2020-01-01', endDate: '2026-01-01' }),
    (err) => err.status === 400 && /at most 366 days/.test(err.message),
  );
  assert.equal(MAX_CUSTOM_RANGE_DAYS, 366);
});

test('range: an unparseable date is refused, not reported as an empty period', () => {
  // Invalid Date makes every comparison NaN-false, so the ordering and span
  // guards both wave it through — a shop would see a month of real trading
  // reported as zero sales.
  for (const bad of [
    { startDate: 'garbage', endDate: '2026-09-30' },
    { startDate: '2026-09-01', endDate: 'not-a-date' },
    { startDate: '2026-13-45', endDate: '2026-09-30' },
  ]) {
    assert.throws(
      () => resolveOverviewRange({ period: 'custom', ...bad }),
      (err) => err.status === 400 && /real dates/.test(err.message),
      `accepted ${JSON.stringify(bad)}`,
    );
  }
});

test('range: an unknown period is rejected instead of quietly defaulting', () => {
  assert.throws(() => resolveOverviewRange({ period: 'quarter' }), (err) => err.status === 400);
});

// ── Trend buckets ───────────────────────────────────────────────────────────

test('buckets: a single day is charted hourly, a month daily', () => {
  const day = resolveOverviewRange({ period: 'today' });
  const hourly = buildTrendBuckets(day.start, day.end);
  assert.equal(hourly.hourly, true);
  assert.equal(hourly.buckets.length, 24);

  const month = resolveOverviewRange({ period: 'custom', startDate: '2026-09-01', endDate: '2026-09-30' });
  const daily = buildTrendBuckets(month.start, month.end);
  assert.equal(daily.hourly, false);
  assert.equal(daily.buckets.length, 30);
});

// ── Asset valuation ─────────────────────────────────────────────────────────

test('asset value: falls back to the purchase price, and says so', () => {
  assert.deepEqual(
    assetUnitValue({ acquisitionValue: 80000, currentValue: null }),
    { value: 80000, basis: 'acquisition' },
  );
});

test('asset value: a current value of 0 is an answer, not a missing one', () => {
  // The bug this guards: `currentValue || acquisitionValue` would resurrect
  // the purchase price for an asset the owner has written down to nothing.
  assert.deepEqual(
    assetUnitValue({ acquisitionValue: 80000, currentValue: 0 }),
    { value: 0, basis: 'current' },
  );
});

// ── Stock valuation ─────────────────────────────────────────────────────────

test('stock value: variant stock is valued, bundles and services are not', () => {
  const expr = stockValueExpression('costPrice');
  const cases = expr.$switch.branches.map((b) => JSON.stringify(b.case));
  assert.ok(cases.some((c) => c.includes('configurable')), 'configurable products must value their variants');
  assert.ok(cases.some((c) => c.includes('bundle')), 'bundles must not double-count their components');
  assert.ok(cases.some((c) => c.includes('trackInventory')), 'untracked products hold no stock');
});

test('stock value: potential margin is sales value less cost', () => {
  const out = shapeValuation({ stockAtCost: 45000, potentialSalesValue: 62000, productCount: 12 });
  assert.equal(out.potentialMargin, 17000);
  assert.equal(out.productCount, 12);
});

test('stock value: an empty shop reports zeroes, not NaN', () => {
  assert.deepEqual(shapeValuation(undefined), {
    stockAtCost: 0, potentialSalesValue: 0, potentialMargin: 0, productCount: 0,
  });
});

// ── Capital position ────────────────────────────────────────────────────────

const stubAggregates = ({ stock, assets }) => {
  mock.method(Product, 'aggregate', async () => (stock ? [stock] : []));
  mock.method(Asset, 'aggregate', async () => (assets ? [assets] : []));
};

test('capital: position is inventory plus assets', async () => {
  stubAggregates({
    stock: { stockAtCost: 165000, potentialSalesValue: 220000, productCount: 80 },
    assets: { estimatedValue: 90000, acquisitionValue: 120000, count: 4, unvaluedCount: 1 },
  });
  const capital = await getCapitalPosition('64b7f1f77bcf86cd79943901');
  assert.equal(capital.estimatedPosition, 255000);
  assert.equal(capital.assets.count, 4);
});

test('capital: untracked components are null and excluded from the total', async () => {
  stubAggregates({
    stock: { stockAtCost: 100, potentialSalesValue: 150, productCount: 1 },
    assets: null,
  });
  const capital = await getCapitalPosition('64b7f1f77bcf86cd79943901');

  const unrecorded = capital.components.filter((c) => !c.recorded);
  assert.deepEqual(unrecorded.map((c) => c.key).sort(), ['liabilities', 'other_funds']);
  for (const c of unrecorded) {
    // The whole point: an unrecorded liability must never read as "owes nothing".
    assert.equal(c.amount, null);
    assert.ok(c.reason.length > 0, `${c.key} must explain why it is missing`);
  }
  assert.equal(capital.estimatedPosition, 100);
  assert.match(capital.disclaimer, /not a formal accounting valuation/i);
});

// ── Product performance ─────────────────────────────────────────────────────

/** Captures the pipeline handed to Mongo and replays a canned $facet result. */
const stubProductPipeline = (facet) => {
  const seen = {};
  mock.method(Product, 'aggregate', async (pipeline) => {
    seen.pipeline = pipeline;
    return [{ rows: [], count: [], totals: [], topUnits: [], topRevenue: [], topProfit: [], ...facet }];
  });
  return seen;
};

test('products: voided and refunded sales are excluded from every figure', async () => {
  const seen = stubProductPipeline({});
  const range = resolveOverviewRange({ period: 'month' });
  await getProductPerformance('64b7f1f77bcf86cd79943901', { ...range, sort: 'most_sold', page: 1, limit: 20 });

  const union = seen.pipeline.find((s) => s.$unionWith);
  const statuses = union.$unionWith.pipeline[0].$match.status.$in;
  assert.deepEqual(statuses, ['completed', 'refund_pending']);
  assert.ok(!statuses.includes('voided'));
  assert.ok(!statuses.includes('refunded'));
});

test('products: revenue comes from the sale line, never the current price', async () => {
  const seen = stubProductPipeline({});
  const range = resolveOverviewRange({ period: 'month' });
  await getProductPerformance('64b7f1f77bcf86cd79943901', { ...range, page: 1, limit: 20 });

  const union = seen.pipeline.find((s) => s.$unionWith);
  const lineProjection = union.$unionWith.pipeline[2].$project;
  // A January sale must stay at January's price — reading $sellingPrice here
  // would rewrite last year's revenue every time the shop reprices.
  assert.equal(lineProjection.revenue, '$items.subtotal');
  assert.equal(lineProjection.units, '$items.quantity');
  assert.equal(JSON.stringify(lineProjection).includes('sellingPrice'), false);
});

test('products: the three rankings are computed on three different metrics', async () => {
  const seen = stubProductPipeline({});
  const range = resolveOverviewRange({ period: 'month' });
  await getProductPerformance('64b7f1f77bcf86cd79943901', { ...range, page: 1, limit: 20 });

  const facet = seen.pipeline.find((s) => s.$facet).$facet;
  assert.ok(facet.topUnits.some((s) => s.$sort?.units === -1));
  assert.ok(facet.topRevenue.some((s) => s.$sort?.revenue === -1));
  assert.ok(facet.topProfit.some((s) => s.$sort?.grossProfit === -1));
});

test('products: every sort key pages deterministically', async () => {
  const range = resolveOverviewRange({ period: 'month' });
  for (const sort of PRODUCT_SORT_KEYS) {
    const seen = stubProductPipeline({});
    await getProductPerformance('64b7f1f77bcf86cd79943901', { ...range, sort, page: 2, limit: 20 });
    const rows = seen.pipeline.find((s) => s.$facet).$facet.rows;
    // Without a tiebreaker, "least sold" (where nearly every row ties at zero)
    // would return overlapping or missing products between pages.
    assert.equal(rows[0].$sort.productId, 1, `${sort} must break ties on productId`);
    assert.equal(rows[1].$skip, 20);
  }
});

test('products: a shop with no sales reports zeroed totals and no highlights', async () => {
  stubProductPipeline({});
  const range = resolveOverviewRange({ period: 'month' });
  const out = await getProductPerformance('64b7f1f77bcf86cd79943901', { ...range, page: 1, limit: 20 });

  assert.deepEqual(out.highlights, { topUnits: null, topRevenue: null, topProfit: null });
  assert.equal(out.totals.revenue, 0);
  assert.equal(out.totals.costEstimated, false);
  assert.equal(out.pagination.pages, 1);
});

test('products: a reconstructed cost taints the period as estimated', async () => {
  stubProductPipeline({
    totals: [{ units: 10, revenue: 1000, cost: 600, grossProfit: 400, productsSold: 1, estimated: 1 }],
    count: [{ value: 1 }],
  });
  const range = resolveOverviewRange({ period: 'month' });
  const out = await getProductPerformance('64b7f1f77bcf86cd79943901', { ...range, page: 1, limit: 20 });
  assert.equal(out.totals.costEstimated, true);
  assert.equal(out.totals.grossProfit, 400);
});
