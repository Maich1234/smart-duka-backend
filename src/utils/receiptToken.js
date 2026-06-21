import jwt from 'jsonwebtoken';

/**
 * Signs a long-lived, stateless token identifying a sale for the public
 * receipt-verification page. No expiry — receipts must stay verifiable
 * indefinitely. Not persisted anywhere; recomputed on demand.
 */
export const signReceiptToken = (saleId) => {
  return jwt.sign({ saleId: saleId.toString() }, process.env.RECEIPT_TOKEN_SECRET);
};

export const verifyReceiptToken = (token) => {
  try {
    const decoded = jwt.verify(token, process.env.RECEIPT_TOKEN_SECRET);
    return decoded.saleId;
  } catch {
    return null;
  }
};
