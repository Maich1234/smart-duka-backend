# Credit repayment corrections and refund review — 29 October 2026

## Method and defects reproduced

Used actual Express HTTP routes, production services and Mongoose models against an isolated MongoDB 7.0.24 replica set with indexes initialized. Synthetic shop owners, permitted staff, customers and goods; no existing test suite, production data or live payment provider.

Two defects were reproduced:

1. Sold KES 200 on credit, recorded its full repayment, refunded the sale in cash, then reversed the repayment. All operations succeeded, leaving the sale refunded, stock returned (10), and the customer owing KES 200 again.
2. Sold KES 200 on credit and cancelled its unpaid debt through the correction endpoint. The sale remained completed and totalRepaid was 0. A cash refund still succeeded because the refund check only looked for an outstanding debt. Cancelling a debt is not proof the customer paid.

## Fixes

Repayment reversal validates that all original allocations are present, total the repayment, refer to the same shop/customer's real debt rows, and do not reopen cancelled debts or exceed their original amount. Missing/inconsistent historical allocations require review rather than silently moving money.

For debts linked to sales, the reversal writes an internal creditRevision guard on each completed sale inside the same transaction. This forces it to serialize with refunds/voids and recheck the outcome after a conflict. Refunded, voided, missing and refund-pending sales cannot regain debt through a repayment correction. The optional guard field is hidden from normal queries and needs no backfill/index.

Refund eligibility now checks the original debt, including cancelled/paid state, rather than treating absence from the outstanding list as proof of repayment. The check runs again inside the cash-refund transaction. Cash sales with customers but no debt remain ordinary cash sales; untracked credit without a settled debt requires review. Debt cancellation itself remains available; it does not automatically become a payment or a sale void.

## Observed after restarting with the fixes

| Operation | Observed result |
| --- | --- |
| Reverse repayment after cash refund | 409 SALE_ALREADY_CORRECTED; debt remains 0, stock 10, no correction row added |
| Refund cancelled unpaid credit debt | 400 CREDIT_SALE_UNPAID; sale completed, stock 8, totalRepaid 0 |
| Reverse a legitimate KES 80 partial repayment | 201; outstanding restored from 120 to 200, totalRepaid 0, stock stays 8; ledger net equals balance |
| Refund and repayment reversal both read before either commits | Only one succeeds; reversal-winning run leaves completed sale/debt 200/stock 8; refund-winning run leaves refunded sale/debt 0/stock 10 |
| Two concurrent reversals of the same repayment | One 201, one 400 ALREADY_REVERSED; one correction row; balance/ledger agree |
| Owner and permitted staff simultaneously collect KES 200 each against KES 200 owed | One 201, one 400; only one repayment; balance 0, totalRepaid 200 |
| Repayment covers two sales; one sale later refunded; reverse the whole repayment | 409; all customer/debt/payment/stock records unchanged from before the attempted reversal |
| Repayment has no allocation information (controlled historical-data fault) | 409 ALLOCATION_UNAVAILABLE; no balance or ledger mutation |
| Standalone opening balance KES 0.03, repay KES 0.01, reverse payment, then reverse opening balance | All valid operations 201; exact 0.03 restored, then balance 0; no sale required |
| Staff tries owner-only correction | 403 |
| Another shop's owner tries correction | 404 |

For correction races a temporary runtime-only query barrier held the initial transaction reads until both requests had read their respective documents. The refund-winning case additionally held the reversal's sale write until the competing refund committed. All actual database operations and transaction retries remained real. No instrumentation is part of production source.

Changed JavaScript passed syntax and whitespace checks. These are backend-only additions to the pending refund safety work; no client response contract or production migration was applied.

## Limits

These checks protect application bookkeeping, not the physical handling of cash. They do not repair previously refunded sales with resurrected debt or inconsistent historical allocations; those need reconciled evidence and support review. Incomplete allocations are deliberately blocked. Real provider sandboxes, callbacks durable across process termination, long-running multi-region contention and whole-system/device certification remain outstanding. No deployment was performed.
