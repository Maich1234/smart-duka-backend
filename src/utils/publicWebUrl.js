const FALLBACK = 'https://duqana.app';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

const isLocalUrl = (value) => {
  try {
    return LOCAL_HOSTNAMES.has(new URL(value).hostname);
  } catch {
    // Not a parseable absolute URL — not safe to use either.
    return true;
  }
};

/**
 * Where the DuQana web app is deployed. QR codes, receipt links, the
 * subscription page, and referral share links are all built from this — so
 * if PUBLIC_WEB_URL is ever left unset, blank, or pointing at a developer's
 * local backend (easy to do by copying a local .env into the wrong place),
 * every one of those links would otherwise leak "localhost" into things
 * real customers see: receipts, referral shares, and billing emails.
 */
export const PUBLIC_WEB_URL = (() => {
  const configured = process.env.PUBLIC_WEB_URL?.trim();
  const url = configured && !isLocalUrl(configured) ? configured : FALLBACK;
  return url.replace(/\/+$/, '');
})();
