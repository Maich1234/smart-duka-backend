import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePagination, paginatedResult } from '../src/utils/pagination.js';

/** Stands in for a Mongoose Query builder: slices a fixed row set. */
const rowsQuery = (rows) => async (skip, limit) => rows.slice(skip, skip + limit);

test('defaults when no query params', () => {
  const { page, limit, skip } = parsePagination({});
  assert.equal(page, 1);
  assert.equal(limit, 20);
  assert.equal(skip, 0);
});

test('parses valid page and limit', () => {
  const { page, limit, skip } = parsePagination({ page: '3', limit: '10' });
  assert.equal(page, 3);
  assert.equal(limit, 10);
  assert.equal(skip, 20);
});

test('clamps limit to maxLimit', () => {
  const { limit } = parsePagination({ limit: '50000' });
  assert.equal(limit, 100);
});

test('non-numeric page/limit fall back to defaults instead of NaN', () => {
  const { page, limit, skip } = parsePagination({ page: 'abc', limit: 'xyz' });
  assert.equal(page, 1);
  assert.equal(limit, 20);
  assert.equal(skip, 0);
  assert.ok(!Number.isNaN(skip));
});

test('negative page clamps to 1; limit=0 falls back to the default', () => {
  const { page, limit } = parsePagination({ page: '-5', limit: '0' });
  assert.equal(page, 1);
  assert.equal(limit, 20);
});

test('negative limit clamps to 1', () => {
  const { limit } = parsePagination({ limit: '-10' });
  assert.equal(limit, 1);
});

test('respects custom defaultLimit', () => {
  const { limit } = parsePagination({}, { defaultLimit: 10 });
  assert.equal(limit, 10);
});

// ── paginatedResult ────────────────────────────────────────────────────────
// Counting the whole collection on every scroll was the slowest part of a
// sales list request. These pin the replacement's two contracts: page 1 still
// reports an exact total, and `page < pages` still terminates.

test('paginatedResult over-fetches by one to detect a next page', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => i);
  let countCalls = 0;

  const result = await paginatedResult(
    { page: 1, limit: 10, skip: 0 },
    rowsQuery(rows),
    async () => { countCalls += 1; return rows.length; },
  );

  assert.equal(result.data.length, 10, 'the probe row is trimmed off');
  assert.deepEqual(result.data, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(result.pagination.total, 25, 'page 1 is the only page whose total a client renders');
  assert.equal(countCalls, 1);
  assert.ok(result.pagination.page < result.pagination.pages, 'infinite scroll must keep loading');
});

test('paginatedResult never counts on pages after the first', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => i);
  let countCalls = 0;

  const result = await paginatedResult(
    { page: 2, limit: 10, skip: 10 },
    rowsQuery(rows),
    async () => { countCalls += 1; return rows.length; },
  );

  assert.equal(countCalls, 0, 'this is the cost being removed');
  assert.equal(result.data.length, 10);
  assert.ok(result.pagination.page < result.pagination.pages);
});

test('paginatedResult stops infinite scroll exactly at the last page', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => i);

  const last = await paginatedResult({ page: 3, limit: 10, skip: 20 }, rowsQuery(rows), async () => rows.length);

  assert.equal(last.data.length, 5, 'partial final page');
  assert.equal(
    last.pagination.page < last.pagination.pages,
    false,
    'the page < pages idiom must terminate, or the client loops forever',
  );
});

test('paginatedResult handles an exact multiple of the page size without a phantom page', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => i);

  const second = await paginatedResult({ page: 2, limit: 10, skip: 10 }, rowsQuery(rows), async () => 20);
  assert.equal(second.data.length, 10);
  assert.equal(second.pagination.page < second.pagination.pages, false);
});

test('paginatedResult handles an empty collection', async () => {
  const result = await paginatedResult({ page: 1, limit: 10, skip: 0 }, rowsQuery([]), async () => 0);
  assert.deepEqual(result.data, []);
  assert.equal(result.pagination.total, 0);
  assert.equal(result.pagination.page < result.pagination.pages, false);
});
