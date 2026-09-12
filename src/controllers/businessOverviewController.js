import Product from '../models/Product.js';
import {
  resolveOverviewRange,
  getCapitalPosition,
  getSalesSummary,
  getProductPerformance,
  PRODUCT_SORT_KEYS,
} from '../services/businessOverviewService.js';
import { getStaffPerformance } from '../services/intelligence/staffPerformanceService.js';
import { parsePagination } from '../utils/pagination.js';

/**
 * The owner's Business Overview. One endpoint per tab, so opening the screen
 * fetches the header and the landing tab only and the rest load when swiped
 * to — a shop with a year of sales should not pay for the Products
 * aggregation to look at its assets.
 *
 * Shop scoping comes from `req.user.shop._id` in every handler. The routes are
 * `ownerOnly`: capital, cost, margin and per-employee sales are exactly the
 * numbers a staff role must never see.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Shared period parsing. `resolveOverviewRange` throws `err.status = 400`. */
const rangeFrom = (query) => resolveOverviewRange({
  period: query.period,
  startDate: query.startDate,
  endDate: query.endDate,
});

const rangeMeta = (range) => ({
  period: range.period,
  startDate: range.start.toISOString(),
  endDate: range.end.toISOString(),
});

/**
 * The collapsing header plus the Overview tab: what the business is worth,
 * what it took today, and how the month is tracking.
 */
export const getBusinessOverview = async (req, res) => {
  const shopId = req.user.shop._id;
  const today = resolveOverviewRange({ period: 'today' });
  const month = resolveOverviewRange({ period: 'month' });

  const [capital, todaySales, monthSales, monthProducts, lowStockCount] = await Promise.all([
    getCapitalPosition(shopId),
    getSalesSummary(shopId, { ...today, includeSeries: false }),
    getSalesSummary(shopId, month),
    // Page 1 of nothing: only the highlights and totals are read here. The
    // full ranked list belongs to the Products tab and is fetched there.
    getProductPerformance(shopId, { ...month, sort: 'most_sold', page: 1, limit: 1 }),
    Product.countDocuments({ shop: shopId, $expr: { $lte: ['$quantity', '$lowStockAlert'] } }),
  ]);

  res.json({
    success: true,
    data: {
      capital,
      inventory: { ...capital.inventory, lowStockCount },
      today: { total: todaySales.total, transactions: todaySales.transactions },
      month: {
        ...rangeMeta(month),
        total: monthSales.total,
        transactions: monthSales.transactions,
        averageSale: monthSales.averageSale,
        grossProfit: monthProducts.totals.grossProfit,
        costEstimated: monthProducts.totals.costEstimated,
        series: monthSales.series,
        highlights: monthProducts.highlights,
      },
    },
  });
};

/** Sales tab: totals, the split across the shop's payment buttons, and a trend. */
export const getBusinessSales = async (req, res) => {
  const range = rangeFrom(req.query);
  const summary = await getSalesSummary(req.user.shop._id, range);
  res.json({ success: true, data: { ...rangeMeta(range), ...summary } });
};

/**
 * Staff tab — sales ATTRIBUTED TO each employee.
 *
 * Named that way on purpose, and the client label matches. Revenue rung up on
 * someone's account measures the till they stood at as much as the person:
 * a cashier on the busy morning shift outsells the stockkeeper by arithmetic,
 * not by effort. DuQana records nothing about hours worked or floor coverage,
 * so it must not present this as a productivity ranking.
 */
export const getBusinessStaff = async (req, res) => {
  const range = rangeFrom(req.query);
  const sort = ['revenue', 'transactions', 'average'].includes(req.query.sort)
    ? req.query.sort
    : 'revenue';

  const { staff } = await getStaffPerformance(req.user.shop._id, { range });

  const totalRevenue = staff.reduce((sum, s) => sum + s.revenue, 0);
  const rows = staff.map((s) => ({
    staffId: s.staffId,
    name: s.name,
    revenue: round2(s.revenue),
    transactions: s.salesCount,
    averageSale: s.salesCount > 0 ? round2(s.revenue / s.salesCount) : 0,
    commission: round2(s.commission),
    sharePercent: totalRevenue > 0 ? round2((s.revenue / totalRevenue) * 100) : 0,
  }));

  const comparators = {
    revenue: (a, b) => b.revenue - a.revenue,
    transactions: (a, b) => b.transactions - a.transactions,
    average: (a, b) => b.averageSale - a.averageSale,
  };
  rows.sort(comparators[sort]);

  res.json({
    success: true,
    data: {
      ...rangeMeta(range),
      sort,
      staff: rows,
      totals: {
        revenue: round2(totalRevenue),
        transactions: rows.reduce((sum, s) => sum + s.transactions, 0),
        sellers: rows.length,
      },
    },
  });
};

/** Products tab: ranked per-product units, revenue, cost and gross profit. */
export const getBusinessProducts = async (req, res) => {
  const range = rangeFrom(req.query);
  const { page, limit } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 50 });
  const sort = PRODUCT_SORT_KEYS.includes(req.query.sort) ? req.query.sort : 'most_sold';

  const result = await getProductPerformance(req.user.shop._id, { ...range, sort, page, limit });

  res.json({
    success: true,
    data: { ...rangeMeta(range), sort, ...result },
    pagination: result.pagination,
  });
};
