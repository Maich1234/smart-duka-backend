import jwt from 'jsonwebtoken';

/** Public quotation links expire 30 days after issue, including legacy links. */
export const signQuotationToken = (quotationId) => {
  return jwt.sign({ quotationId: quotationId.toString() }, process.env.RECEIPT_TOKEN_SECRET, { expiresIn: '30d' });
};

export const verifyQuotationToken = (token) => {
  try {
    const decoded = jwt.verify(token, process.env.RECEIPT_TOKEN_SECRET, { maxAge: '30d' });
    return decoded.quotationId;
  } catch {
    return null;
  }
};
