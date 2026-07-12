import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePagination } from '../src/utils/pagination.js';

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
