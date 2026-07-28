/**
 * How money *left* the business — recorded on expenses and purchases.
 *
 * Deliberately not the same list as Sale.paymentMethod ('cash' | 'mpesa' |
 * 'card'), which describes money coming in. A shop pays suppliers by bank
 * transfer and on credit; it does not get paid by credit card as often as it
 * pays by account.
 *
 * The Cashbook is the reason this exists: without it an expense settled by
 * M-Pesa is indistinguishable from cash lifted out of the till, and a purchase
 * taken on account looks identical to one paid on the spot. A cashbook built on
 * that is fiction.
 *
 * 'credit' means **no money moved yet**. Such records must be excluded from the
 * Cashbook entirely. Settlement (paying the supplier later) is not yet tracked —
 * that arrives with the Creditors book — so a credit purchase currently never
 * appears in the Cashbook at all. That is still strictly more accurate than
 * booking cash that never left, and capturing the flag now means the Creditors
 * book will have history to work from when it lands.
 */
export const MONEY_OUT_METHODS = ['cash', 'mpesa', 'bank', 'credit'];

/** Methods that actually moved money, i.e. the ones a Cashbook may include. */
export const CASH_MOVING_METHODS = MONEY_OUT_METHODS.filter((m) => m !== 'credit');
