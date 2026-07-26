// Clamped pagination parsing for list endpoints. Guards against
// ?page=abc (NaN skip crashes the Mongo query) and ?limit=50000
// (unbounded reads that load an entire collection).
export const parsePagination = (query, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};

/**
 * Runs a paginated list query without counting the whole collection on every
 * page.
 *
 * `countDocuments` on a high-volume collection (sales, once a busy shop has
 * years of history) is the slowest part of a list request and it was being
 * paid on every scroll. Instead we over-fetch by one document to learn whether
 * another page exists, and only pay for an exact count on page 1 — which is
 * the only page whose `total` any client displays.
 *
 * The returned `pages` stays truthful enough for the `page < pages` idiom
 * infinite scrolls use: it reports one page beyond the current one while more
 * data exists, and settles on the real last page at the end.
 *
 * @param buildQuery - (skip, limit) => a Mongoose Query (not yet awaited)
 * @param countQuery - () => Promise<number>, only called on page 1
 */
export const paginatedResult = async ({ page, limit, skip }, buildQuery, countQuery) => {
  const rows = await buildQuery(skip, limit + 1);
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  const total = page === 1
    ? await countQuery()
    // Later pages: a lower bound is enough — no client renders it.
    : skip + data.length + (hasMore ? 1 : 0);

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      pages: hasMore ? page + 1 : Math.max(page, Math.ceil(total / limit)),
    },
  };
};
