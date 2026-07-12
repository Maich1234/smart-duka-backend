// Clamped pagination parsing for list endpoints. Guards against
// ?page=abc (NaN skip crashes the Mongo query) and ?limit=50000
// (unbounded reads that load an entire collection).
export const parsePagination = (query, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};
