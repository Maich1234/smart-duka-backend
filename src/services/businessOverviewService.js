import mongoose from 'mongoose';
import Sale from '../models/Sale.js';
import Product from '../models/Product.js';
import Asset, { LIVE_ASSET_MATCH } from '../models/Asset.js';
import { resolveRange } from '../utils/dateRanges.js';
import { getInventoryValuation } from './inventoryValuationService.js';

/**
 * The owner's business overview: what the shop owns, what it is roughly
 * worth, what sold, and who sold it.
 *
 * Everything here is aggregated in MongoDB and scoped by `shop` from the
 * authenticated user — never from anything the client sends. No new figures
 * are invented: revenue and cost come from the snapshots each sale already
 * carries, stock value from the shared inventory valuation, and anything
 * DuQana does not actually record is returned as `null` with a reason
 * rather than as a confident zero.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Statuses that count as money earned. A void means the sale was recorded in
 * error; a completed refund means the money went back. `refund_pending` still
 * counts — the cash is with the shop until Safaricom completes the reversal.
 * Identical to the definition in dailySummaryService and profitLossService.
 */
const REVENUE_STATUSES = ['completed', 'refund_pending'];

export const OVERVIEW_PERIODS = ['today', 'week', 'month', 'last_month', 'custom'];

/** A custom range wider than this is refused rather than served slowly. */
export const MAX_CUSTOM_RANGE_DAYS = 366;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const badRequest = (message) => {
  const err = new Error(message);
  err.status = 400;
  return err;
};

/**
 * Turns a period key into one [start, end) window.
 *
 * Boundaries are UTC, delegated to the same `resolveRange` the reconciliation
 * and books modules use. That is deliberate even though Kenya is UTC+3: every
 * other financial figure in DuQana (DailySummary, Cashbook, P&L) is bucketed
 * this way, and a screen that drew its own local-midnight boundary would
 * disagree with all of them on exactly the sales that straddle it.
 */
export function resolveOverviewRange({ period = 'month', startDate, endDate } = {}) {
  if (period && !OVERVIEW_PERIODS.includes(period)) {
    throw badRequest(`period must be one of: ${OVERVIEW_PERIODS.join(', ')}`);
  }

  if (period === 'custom') {
    if (!startDate || !endDate) {
      throw badRequest('A custom period needs both startDate and endDate.');
    }
    const range = resolveRange({ startDate, endDate });
    // Checked before the comparisons below, not after: an unparseable date
    // yields an Invalid Date, every comparison against NaN is false, and both
    // guards would wave it through to the aggregation — which then reports an
    // empty period as though the shop had genuinely sold nothing.
    if (Number.isNaN(range.start.getTime()) || Number.isNaN(range.end.getTime())) {
      throw badRequest('startDate and endDate must be real dates (YYYY-MM-DD).');
    }
    if (range.end <= range.start) {
      throw badRequest('endDate must be on or after startDate.');
    }
    if (range.end - range.start > MAX_CUSTOM_RANGE_DAYS * DAY_MS) {
      throw badRequest(`A custom period can cover at most ${MAX_CUSTOM_RANGE_DAYS} days.`);
    }
    return { ...range, period };
  }

  if (period === 'today') return { ...resolveRange({ period: 'day' }), period };
  if (period === 'week') return { ...resolveRange({ period: 'week' }), period };
  if (period === 'last_month') {
    const now = new Date();
    const ref = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return { ...resolveRange({ period: 'month', date: ref }), period };
  }
  return { ...resolveRange({ period: 'month' }), period };
}

/**
 * A period that has not finished yet (this month, this week, today) must not
 * be measured against its full length — a product added yesterday would look
 * like it had thirty days to sell in. Everything date-elapsed is measured to
 * here instead of to `end`.
 */
const elapsedEnd = (end, now = new Date()) => (end > now ? now : end);

// ── Capital position ────────────────────────────────────────────────────────

/**
 * Why two components are `null` rather than 0.
 *
 * Cash/float: DuQana never keeps a running balance for a till or an M-Pesa
 * account. A shift close records a counted drawer for that one session, which
 * is not the same thing and would be stale the moment the next sale rings up.
 *
 * Liabilities: a purchase taken on credit is recorded (Purchase.paymentMethod
 * === 'credit') but its settlement is not — so the total ever bought on credit
 * is knowable while the amount still owed is not, and the first is a bad proxy
 * for the second. Reporting 0 would claim the shop owes nothing.
 */
const UNRECORDED_COMPONENTS = [
  {
    key: 'other_funds',
    label: 'Other tracked funds',
    reason: 'DuQana does not keep a running cash or M-Pesa balance, so money in the till or on the line is not counted here.',
  },
  {
    key: 'liabilities',
    label: 'Liabilities',
    reason: 'Stock bought on supplier credit is recorded, but repayments are not, so an outstanding balance cannot be worked out yet.',
  },
];

export const CAPITAL_DISCLAIMER =
  'An operational estimate from what you have recorded in DuQana — not a formal accounting valuation.';

/** Value of one asset line: (current value, or what it cost) × how many. */
const assetLineValue = (field) => ({
  $multiply: [
    { $ifNull: ['$quantity', 1] },
    field === 'current'
      // `$ifNull` treats a stored 0 as a real answer, which it is: an owner
      // who says a thing is worthless now must not silently get its old price.
      ? { $ifNull: ['$currentValue', { $ifNull: ['$acquisitionValue', 0] }] }
      : { $ifNull: ['$acquisitionValue', 0] },
  ],
});

export async function getAssetPosition(shopId) {
  const shop = new mongoose.Types.ObjectId(String(shopId));
  const [row] = await Asset.aggregate([
    { $match: { shop, ...LIVE_ASSET_MATCH } },
    {
      $group: {
        _id: null,
        estimatedValue: { $sum: assetLineValue('current') },
        acquisitionValue: { $sum: assetLineValue('acquisition') },
        count: { $sum: 1 },
        // How many rows are standing in their purchase price because the owner
        // has not estimated a current value — the UI says so rather than
        // implying the whole figure is a present-day valuation.
        unvaluedCount: {
          $sum: { $cond: [{ $eq: [{ $ifNull: ['$currentValue', null] }, null] }, 1, 0] },
        },
      },
    },
  ]);

  return {
    estimatedValue: round2(row?.estimatedValue),
    acquisitionValue: round2(row?.acquisitionValue),
    count: row?.count ?? 0,
    unvaluedCount: row?.unvaluedCount ?? 0,
  };
}

/**
 * Estimated business capital: what the shop owns, less what it owes — as far
 * as DuQana can actually see. `estimatedPosition` sums only the components
 * marked `recorded`, so an unrecorded liability can never quietly flatter it.
 */
export async function getCapitalPosition(shopId) {
  const [inventory, assets] = await Promise.all([
    getInventoryValuation(shopId),
    getAssetPosition(shopId),
  ]);

  const components = [
    { key: 'inventory', label: 'Stock at cost', amount: inventory.stockAtCost, recorded: true },
    { key: 'assets', label: 'Business assets', amount: assets.estimatedValue, recorded: true },
    ...UNRECORDED_COMPONENTS.map((c) => ({ ...c, amount: null, recorded: false })),
  ];

  return {
    components,
    estimatedPosition: round2(
      components.reduce((sum, c) => (c.recorded ? sum + c.amount : sum), 0),
    ),
    inventory,
    assets,
    disclaimer: CAPITAL_DISCLAIMER,
  };
}

// ── Sales ───────────────────────────────────────────────────────────────────

/**
 * Chart buckets for a range: hourly when it covers a single day (a day's
 * trend as 24 points is the only useful shape), daily otherwise.
 */
export function buildTrendBuckets(start, end) {
  const hourly = end - start <= DAY_MS;
  const step = hourly ? 60 * 60 * 1000 : DAY_MS;
  const buckets = [];
  for (let t = start.getTime(); t < end.getTime(); t += step) {
    const bucketStart = new Date(t);
    buckets.push({
      start: bucketStart,
      label: hourly
        ? `${String(bucketStart.getUTCHours()).padStart(2, '0')}:00`
        : bucketStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
    });
  }
  return { buckets, hourly };
}

/**
 * Period sales: the headline totals, the split across whichever payment
 * buttons the shop actually uses, and a zero-filled trend.
 *
 * The split is grouped by the method key rather than hardcoding cash/M-Pesa:
 * shops define their own buttons (Airtel Money, a bank account, a Pochi), and
 * a two-way split silently dropped everything else. `paymentMethodLabel` is
 * the button's name snapshotted at sale time, so a renamed method keeps its
 * historical label.
 */
export async function getSalesSummary(shopId, { start, end, includeSeries = true }) {
  const shop = new mongoose.Types.ObjectId(String(shopId));
  const match = { shop, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: start, $lt: end } };
  const { buckets } = includeSeries ? buildTrendBuckets(start, end) : { buckets: [] };
  const boundaries = [...buckets.map((b) => b.start), end];

  const [methodAgg, bucketAgg] = await Promise.all([
    Sale.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$paymentMethod',
          label: { $max: '$paymentMethodLabel' },
          total: { $sum: '$totalAmount' },
          transactions: { $sum: 1 },
        },
      },
      { $sort: { total: -1 } },
    ]),
    // Skipped entirely when the caller only wants the headline totals — the
    // Overview tab's "today" figures have no chart to feed.
    includeSeries
      ? Sale.aggregate([
        { $match: match },
        {
          $bucket: {
            groupBy: '$createdAt',
            boundaries,
            output: { total: { $sum: '$totalAmount' }, transactionCount: { $sum: 1 } },
          },
        },
      ])
      : [],
  ]);

  const total = round2(methodAgg.reduce((sum, m) => sum + m.total, 0));
  const transactions = methodAgg.reduce((sum, m) => sum + m.transactions, 0);

  // $bucket keys each group by its lower boundary; zero-fill the rest so gaps
  // in trading show as gaps rather than vanishing from the chart.
  const byStart = new Map(bucketAgg.map((b) => [new Date(b._id).getTime(), b]));

  return {
    total,
    transactions,
    averageSale: transactions > 0 ? round2(total / transactions) : 0,
    byMethod: methodAgg.map((m) => ({
      key: m._id,
      label: m.label || m._id,
      total: round2(m.total),
      transactions: m.transactions,
      sharePercent: total > 0 ? round2((m.total / total) * 100) : 0,
    })),
    series: buckets.map((b) => {
      const agg = byStart.get(b.start.getTime());
      return {
        label: b.label,
        date: b.start.toISOString(),
        total: round2(agg?.total ?? 0),
        transactionCount: agg?.transactionCount ?? 0,
      };
    }),
  };
}

// ── Product performance ─────────────────────────────────────────────────────

export const PRODUCT_SORTS = {
  most_sold: { units: -1 },
  least_sold: { units: 1 },
  highest_revenue: { revenue: -1 },
  lowest_revenue: { revenue: 1 },
  highest_profit: { grossProfit: -1 },
  lowest_profit: { grossProfit: 1 },
};

export const PRODUCT_SORT_KEYS = Object.keys(PRODUCT_SORTS);

/**
 * Per-product units, revenue, cost, gross profit and margin for a period.
 *
 * Built as a union of the catalogue and the period's sale lines, rather than
 * from sale lines alone, for one reason: a product that sold nothing is the
 * most important row in a "what isn't moving" list, and it has no sale lines
 * to be found in. The union also keeps products deleted since the sale — they
 * fall back to the name snapshotted on the line.
 *
 * Revenue uses `items.subtotal` (the price actually charged, snapshotted at
 * sale time), never today's `sellingPrice`; cost uses `items.costTotal` the
 * same way. Only lines recorded before per-sale costs existed fall back to the
 * product's current cost, and any row that had to do so is flagged
 * `costEstimated` so the UI never presents a reconstruction as measured.
 */
export async function getProductPerformance(shopId, { start, end, sort = 'most_sold', page = 1, limit = 20 }) {
  const shop = new mongoose.Types.ObjectId(String(shopId));
  const sortSpec = PRODUCT_SORTS[sort] ?? PRODUCT_SORTS.most_sold;
  const skip = (page - 1) * limit;
  const rangeEnd = elapsedEnd(end);
  const periodDays = Math.max(1, Math.ceil((rangeEnd - start) / DAY_MS));

  const [result] = await Product.aggregate([
    { $match: { shop } },
    {
      $project: {
        _id: 0,
        productId: '$_id',
        name: '$name',
        snapshotName: { $literal: null },
        createdAt: '$createdAt',
        costPrice: '$costPrice',
        stockOnHand: { $ifNull: ['$quantity', 0] },
        units: { $literal: 0 },
        revenue: { $literal: 0 },
        snapshotCost: { $literal: 0 },
        unsnapshottedUnits: { $literal: 0 },
        estimatedLines: { $literal: 0 },
      },
    },
    {
      $unionWith: {
        coll: 'sales',
        pipeline: [
          { $match: { shop, status: { $in: REVENUE_STATUSES }, createdAt: { $gte: start, $lt: end } } },
          { $unwind: '$items' },
          {
            $project: {
              _id: 0,
              productId: '$items.productId',
              // Only the catalogue branch carries these; `$max` below ignores
              // nulls, so the real value always wins over the placeholders.
              name: { $literal: null },
              snapshotName: '$items.productName',
              createdAt: { $literal: null },
              costPrice: { $literal: null },
              stockOnHand: { $literal: 0 },
              units: '$items.quantity',
              revenue: '$items.subtotal',
              snapshotCost: { $ifNull: ['$items.costTotal', 0] },
              unsnapshottedUnits: {
                $cond: [{ $eq: [{ $ifNull: ['$items.costTotal', null] }, null] }, '$items.quantity', 0],
              },
              estimatedLines: { $cond: [{ $eq: ['$items.costEstimated', true] }, 1, 0] },
            },
          },
        ],
      },
    },
    {
      $group: {
        _id: '$productId',
        name: { $max: '$name' },
        snapshotName: { $max: '$snapshotName' },
        createdAt: { $max: '$createdAt' },
        costPrice: { $max: '$costPrice' },
        stockOnHand: { $max: '$stockOnHand' },
        units: { $sum: '$units' },
        revenue: { $sum: '$revenue' },
        snapshotCost: { $sum: '$snapshotCost' },
        unsnapshottedUnits: { $sum: '$unsnapshottedUnits' },
        estimatedLines: { $sum: '$estimatedLines' },
      },
    },
    {
      $addFields: {
        cost: {
          $add: ['$snapshotCost', { $multiply: ['$unsnapshottedUnits', { $ifNull: ['$costPrice', 0] }] }],
        },
        // A product added mid-period had fewer days to sell in, and ranking it
        // against one that was on the shelf all month without saying so is the
        // single easiest way to mislabel a new line as a bad one.
        availableFrom: { $cond: [{ $gt: ['$createdAt', start] }, '$createdAt', start] },
      },
    },
    {
      $addFields: {
        grossProfit: { $subtract: ['$revenue', '$cost'] },
        availableDays: {
          $min: [
            periodDays,
            { $max: [1, { $ceil: { $divide: [{ $subtract: [rangeEnd, '$availableFrom'] }, DAY_MS] } }] },
          ],
        },
      },
    },
    {
      $project: {
        _id: 0,
        productId: '$_id',
        name: { $ifNull: ['$name', '$snapshotName'] },
        units: { $round: ['$units', 3] },
        revenue: { $round: ['$revenue', 2] },
        cost: { $round: ['$cost', 2] },
        grossProfit: { $round: ['$grossProfit', 2] },
        marginPercent: {
          $cond: [
            { $gt: ['$revenue', 0] },
            { $round: [{ $multiply: [{ $divide: ['$grossProfit', '$revenue'] }, 100] }, 1] },
            0,
          ],
        },
        stockOnHand: 1,
        availableDays: 1,
        // False for a product added mid-period — the client shows "available
        // for N days" next to it instead of ranking it silently.
        availableWholePeriod: { $gte: ['$availableDays', periodDays] },
        costEstimated: {
          $or: [{ $gt: ['$estimatedLines', 0] }, { $gt: ['$unsnapshottedUnits', 0] }],
        },
        // A product deleted from the catalogue since it sold.
        inCatalogue: { $ne: [{ $ifNull: ['$createdAt', null] }, null] },
      },
    },
    {
      $facet: {
        // `_id` is not in scope after the projection above; productId is the
        // tiebreaker that keeps paging stable when a sort key ties (and with
        // `least_sold` almost every row ties at zero).
        rows: [{ $sort: { ...sortSpec, productId: 1 } }, { $skip: skip }, { $limit: limit }],
        count: [{ $count: 'value' }],
        totals: [
          {
            $group: {
              _id: null,
              units: { $sum: '$units' },
              revenue: { $sum: '$revenue' },
              cost: { $sum: '$cost' },
              grossProfit: { $sum: '$grossProfit' },
              productsSold: { $sum: { $cond: [{ $gt: ['$units', 0] }, 1, 0] } },
              estimated: { $max: { $cond: ['$costEstimated', 1, 0] } },
            },
          },
        ],
        // The three rankings the owner actually asks for, each computed on its
        // own metric. They are deliberately separate: the best-selling product
        // and the most profitable one are usually not the same product, and
        // presenting one as "best" would be the wrong answer to both questions.
        topUnits: [{ $match: { units: { $gt: 0 } } }, { $sort: { units: -1, productId: 1 } }, { $limit: 1 }],
        topRevenue: [{ $match: { revenue: { $gt: 0 } } }, { $sort: { revenue: -1, productId: 1 } }, { $limit: 1 }],
        topProfit: [{ $match: { units: { $gt: 0 } } }, { $sort: { grossProfit: -1, productId: 1 } }, { $limit: 1 }],
      },
    },
  ]);

  const totals = result?.totals?.[0];
  const total = result?.count?.[0]?.value ?? 0;

  return {
    rows: result?.rows ?? [],
    highlights: {
      topUnits: result?.topUnits?.[0] ?? null,
      topRevenue: result?.topRevenue?.[0] ?? null,
      topProfit: result?.topProfit?.[0] ?? null,
    },
    totals: {
      units: round2(totals?.units),
      revenue: round2(totals?.revenue),
      cost: round2(totals?.cost),
      grossProfit: round2(totals?.grossProfit),
      productsSold: totals?.productsSold ?? 0,
      productCount: total,
      costEstimated: (totals?.estimated ?? 0) > 0,
    },
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  };
}
