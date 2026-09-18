import jwt from 'jsonwebtoken';

/**
 * Signs a long-lived, stateless token identifying a quotation for the public
 * share page. No expiry on the token itself — a quotation past its
 * validUntil is still viewable, just shown with an "expired" notice; that's
 * a display concern for the page, not a token concern. Mirrors
 * receiptToken.js exactly.
 */
export const signQuotationToken = (quotationId) => {
  return jwt.sign({ quotationId: quotationId.toString() }, process.env.RECEIPT_TOKEN_SECRET);
};

export const verifyQuotationToken = (token) => {
  try {
    const decoded = jwt.verify(token, process.env.RECEIPT_TOKEN_SECRET);
    return decoded.quotationId;
  } catch {
    return null;
  }
};
