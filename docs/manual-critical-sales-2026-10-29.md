# Critical sales and inventory review — 29 October 2026

## Method

Exercised actual Express HTTP endpoints, production services and Mongoose models against an isolated MongoDB 7.0.24 replica set with declared indexes initialized. Used synthetic owners, staff, shops, products, customers and payment records. Inspected database quantities, sales counts, payment claims and credit balances after requests. No existing test suite, production database, live provider or real money was used.

## Reproduced defects and fixes

1. Sold three bundles containing two units of flour each. Changed the bundle recipe to five units of oil. Voiding the old sale returned HTTP 200 but left flour at 94 and increased oil from 100 to 115. Restoration consulted the current recipe rather than the original deduction.
2. A successful synthetic M-Pesa transaction for KES 1 paid for a KES 100 basket: HTTP 201. Confirmation was checked, but coverage of the server-priced basket was not.

New sales now persist server-generated stock movements in the same transaction as stock deduction and sale creation. Refunds/voids restore those movements, preserving the exact products, variants and quantities even if recipes, types or tracking settings change. An explicit empty array means no stock moved. Missing snapshots identify legacy sales and retain their prior restoration behavior; exact historical recipes cannot be reconstructed reliably. Deleted products/variants remain best effort and are skipped.

Linked M-Pesa transactions are re-read within the sale transaction and must be successful and cover the server-computed total to the nearest cent. Insufficient amounts return PAYMENT_AMOUNT_INSUFFICIENT. The atomic claim also requires the same shop and successful state. This applies to linked transaction IDs and typed receipt codes that match a recorded transaction. Unknown manually entered receipts retain the existing manual-payment workflow; they are not independently verified by this change.

## Observed after fixes

| Operation | Observed result |
| --- | --- |
| Bundle plus a separate line using its component; edit recipe and disable component tracking; void | HTTP 201/200; original flour restored from 93 to 100; unrelated oil stayed 100 |
| Void again under a different key | HTTP 400; no second stock restoration |
| One basket covering standard, variable, weighted, refillable, service and configurable products | HTTP 201; fractional quantities accepted for measured products; five movement records, none for the untracked service |
| Disable tracking after that sale, then cash refund | HTTP 200; each product and variant returned to its original quantity |
| Refund again under a different key | HTTP 400; no duplicate restoration |
| Basket containing an own-shop product followed by a foreign-shop product | HTTP 400; no sale; own-shop stock unchanged |
| Staff without void permission | HTTP 403 |
| Other owner reads this shop's sale | HTTP 404 |
| Confirmed KES 1 transfer for KES 100 basket | HTTP 400 with PAYMENT_AMOUNT_INSUFFICIENT; stock unchanged; no sale or payment claim |
| Typed receipt matching a pending transaction | HTTP 400; stock unchanged |
| Two simultaneous distinct-key sales using one confirmed KES 100 payment | HTTP 201/400; one sale, one stock deduction, one payment claim |
| Two simultaneous KES 100 credit sales for a customer with KES 150 available | One 201, one 400 CREDIT_LIMIT_EXCEEDED; outstanding 100; only one sale and stock deduction |
| Repay KES 40 of that debt, then attempt to void its sale | Repayment 201; void 400; outstanding remains 60; stock unchanged |

Restarted the application after the final payment guard, then repeated the inventory, access, payment-claim and credit scenarios above. Changed modules were loaded through the actual API; whitespace checking passed.

## Limits

No production migration is needed for the optional stock snapshot. Older sales cannot gain an exact snapshot without historical evidence. Physical-phone checkout/printing, real provider reversals, callback delivery, concurrent refund/void contention, purchasing, shifts, quotation conversion and a full security audit remain separate work. This review does not certify all system functionality or eliminate every payment risk.
