// Matches the receipt code Safaricom puts at the very start of every M-Pesa
// confirmation SMS, e.g. "QGH7XXXXX Confirmed. Ksh500.00 sent to...".
export const MPESA_RECEIPT_PATTERN = /^([A-Z0-9]{8,12})\s+Confirmed/i;
export const MPESA_AMOUNT_PATTERN = /Ksh\s?([\d,]+\.\d{2})/i;
