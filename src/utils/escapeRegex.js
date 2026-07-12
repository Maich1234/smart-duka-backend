// User search text is interpolated into $regex queries — unescaped, a search
// for "(" is an invalid pattern (500) and crafted input can trigger
// catastrophic backtracking. Escape everything; searches are literal.
export const escapeRegex = (text = '') => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
