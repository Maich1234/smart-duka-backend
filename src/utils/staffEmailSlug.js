const SYSTEM_EMAIL_ROOT = 'duqana.app';
const SLUG_LENGTH_THRESHOLD = 15;

function wordsOf(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Shop-name -> domain-safe slug for system-generated staff emails.
 * Single word -> itself, truncated (nothing to abbreviate to initials).
 * Multiple words -> concatenated; falls back to initials past the
 * threshold so a long shop name doesn't produce an unwieldy domain.
 */
export function slugifyShopName(shopName) {
  const words = wordsOf(shopName);
  if (words.length === 0) return 'shop';
  if (words.length === 1) return words[0].slice(0, SLUG_LENGTH_THRESHOLD);
  const joined = words.join('');
  return joined.length <= SLUG_LENGTH_THRESHOLD ? joined : words.map((w) => w[0]).join('');
}

export function buildSystemEmailDomain(shopName) {
  return `${slugifyShopName(shopName)}.${SYSTEM_EMAIL_ROOT}`;
}

/** True when `email` belongs to this shop's own system-generated domain. */
export function isSystemGeneratedEmail(email, shopName) {
  const domain = buildSystemEmailDomain(shopName);
  return (email || '').toLowerCase().trim().endsWith(`@${domain}`);
}
