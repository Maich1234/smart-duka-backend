const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDayUTC(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function startOfWeekUTC(date) {
  const d = startOfDayUTC(date);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1) - day; // shift to Monday
  return new Date(d.getTime() + diff * DAY_MS);
}

function startOfMonthUTC(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Resolves a single explicit [start, end) window for reconciliation queries.
 * Unlike salesTrendService's buildBuckets (a rolling "last N periods ending
 * now" trend window), this answers "the month of July" for an arbitrary
 * reference date — what an owner reconciling a past period actually needs.
 * Boundaries are UTC, matching dailySummaryService's day-window convention,
 * so reconciliation totals reconcile against DailySummary docs for the same
 * range.
 */
export function resolveRange({ period = 'day', date, startDate, endDate } = {}) {
  if (startDate || endDate) {
    if (!startDate || !endDate) {
      const err = new Error('Both startDate and endDate are required together.');
      err.status = 400;
      throw err;
    }
    return {
      start: startOfDayUTC(startDate),
      end: new Date(startOfDayUTC(endDate).getTime() + DAY_MS),
    };
  }

  const ref = date ? new Date(date) : new Date();

  if (period === 'week') {
    const start = startOfWeekUTC(ref);
    return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
  }

  if (period === 'month') {
    const start = startOfMonthUTC(ref);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    return { start, end };
  }

  const start = startOfDayUTC(ref);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}
