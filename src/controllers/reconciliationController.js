import { resolveRange } from '../utils/dateRanges.js';
import { getCashierReconciliation, getMonthlyFinancialReconciliation } from '../services/reconciliationService.js';

const shiftManagementEnabled = (req) => req.user.shop?.shiftManagementEnabled === true;

/**
 * GET /reconciliation/cashiers — per-staff sales + cash-drawer reconciliation
 * for a day/week/month (or explicit range). Owners see every cashier (or one,
 * via ?staffId=); anyone else is force-scoped to their own data regardless of
 * what they pass, mirroring shiftController.getShifts/saleController.getSales.
 */
export const getCashiers = async (req, res) => {
  if (req.user.role !== 'owner' && !req.user.permissions?.includes('view_reconciliation')) {
    return res.status(403).json({ success: false, message: 'Access denied.' });
  }

  if (!shiftManagementEnabled(req)) {
    return res.json({ success: true, enabled: false, data: { cashiers: [] } });
  }

  const { period, date, startDate, endDate, staffId } = req.query;
  const { start, end } = resolveRange({ period, date, startDate, endDate });
  const scopedStaffId = req.user.role === 'owner' ? staffId : req.user._id;

  const data = await getCashierReconciliation({
    shopId: req.user.shop._id,
    start,
    end,
    staffId: scopedStaffId,
  });

  res.json({ success: true, enabled: true, data: { ...data, period, start, end } });
};

/**
 * GET /reconciliation/monthly — shop-wide sales vs. expenses vs. purchases
 * for a month (or explicit range). Owner-only via the route's role middleware,
 * not inline scoping — there's no legitimate single-staff view of shop-wide P&L.
 */
export const getMonthly = async (req, res) => {
  const { date, startDate, endDate } = req.query;
  const { start, end } = resolveRange({ period: 'month', date, startDate, endDate });

  const data = await getMonthlyFinancialReconciliation({
    shopId: req.user.shop._id,
    start,
    end,
  });

  res.json({ success: true, data: { ...data, start, end } });
};
