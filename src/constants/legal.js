/**
 * The version of the Terms of Service and Privacy Policy currently in force.
 *
 * Bump this whenever either document changes materially. It is stored against
 * each user at registration, so we can answer "which version did this person
 * actually agree to, and when" — which is the entire point of the consent
 * checkbox. A checkbox whose result is never recorded is decoration.
 *
 * Format is the effective date of the documents, which keeps it obvious what a
 * stored value refers to without a lookup table.
 */
export const CURRENT_TERMS_VERSION = '2026-07-26';
