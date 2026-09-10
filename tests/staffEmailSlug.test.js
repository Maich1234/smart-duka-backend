import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugifyShopName,
  buildSystemEmailDomain,
  isSystemGeneratedEmail,
  isAnySystemGeneratedEmail,
} from '../src/utils/staffEmailSlug.js';

// ── slugifyShopName ─────────────────────────────────────────────────────────

test('slugifyShopName: single word is lowercased and truncated to 15 chars', () => {
  assert.equal(slugifyShopName('JoesShop'), 'joesshop');
  assert.equal(slugifyShopName('Supercalifragilistic'), 'supercalifragil'); // 15 chars
});

test('slugifyShopName: multiple words concatenate when the join fits within 15 chars', () => {
  assert.equal(slugifyShopName('Joe Corner Shop'), 'joecornershop'); // 13 chars
});

test('slugifyShopName: multiple words fall back to initials past the 15-char threshold', () => {
  assert.equal(slugifyShopName('The Great Nairobi General Store'), 'tgngs');
});

test('slugifyShopName: strips punctuation and collapses whitespace before slugging', () => {
  assert.equal(slugifyShopName("Joe's  Corner!  Shop"), 'joescornershop');
});

test('slugifyShopName: empty/whitespace-only name falls back to "shop"', () => {
  assert.equal(slugifyShopName(''), 'shop');
  assert.equal(slugifyShopName('   '), 'shop');
  assert.equal(slugifyShopName(undefined), 'shop');
});

// ── buildSystemEmailDomain / isSystemGeneratedEmail ─────────────────────────

test('buildSystemEmailDomain: appends the system email root to the slug', () => {
  assert.equal(buildSystemEmailDomain('Joes Shop'), 'joesshop.duqana.co.ke');
});

test('isSystemGeneratedEmail: true for an address on this shop\'s own generated domain', () => {
  assert.equal(isSystemGeneratedEmail('jane.otieno@joesshop.duqana.co.ke', 'Joes Shop'), true);
});

test('isSystemGeneratedEmail: is case-insensitive and tolerates surrounding whitespace', () => {
  assert.equal(isSystemGeneratedEmail(' Jane.Otieno@JoesShop.DUQANA.CO.KE ', 'Joes Shop'), true);
});

test('isSystemGeneratedEmail: false for a real inbox, even one that shares the local part', () => {
  assert.equal(isSystemGeneratedEmail('jane.otieno@gmail.com', 'Joes Shop'), false);
});

test('isSystemGeneratedEmail: false for another shop\'s generated domain (not just any duqana.co.ke suffix)', () => {
  assert.equal(isSystemGeneratedEmail('jane.otieno@othershop.duqana.co.ke', 'Joes Shop'), false);
});

// ── isAnySystemGeneratedEmail ────────────────────────────────────────────────

test('isAnySystemGeneratedEmail: true for any shop\'s generated domain, without needing shop context', () => {
  assert.equal(isAnySystemGeneratedEmail('jane.otieno@joesshop.duqana.co.ke'), true);
  assert.equal(isAnySystemGeneratedEmail('bob@anothershop.duqana.co.ke'), true);
});

test('isAnySystemGeneratedEmail: false for a real inbox', () => {
  assert.equal(isAnySystemGeneratedEmail('bob@gmail.com'), false);
});

test('isAnySystemGeneratedEmail: false for the bare root domain (not a shop subdomain) and other falsy input', () => {
  assert.equal(isAnySystemGeneratedEmail('info@duqana.co.ke'), false);
  assert.equal(isAnySystemGeneratedEmail(''), false);
  assert.equal(isAnySystemGeneratedEmail(undefined), false);
});
