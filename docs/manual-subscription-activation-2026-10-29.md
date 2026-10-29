# Manual subscription activation review — 29 October 2026

## Method

Ran the production Express application against a fresh, isolated MongoDB 7.0.24 replica set with real indexes. Submitted HTTP M-Pesa-shaped callbacks to the actual callback route and zero-cost checkout requests to the authenticated payment route. Inspected persisted subscription, payment and promotion documents. Called the production activation service directly to reproduce overlapping callback/reconciliation processing and a database validation failure. Existing test suites were not used.

All users, shops, payments, callback tokens and promotions were synthetic. No provider credentials, production database or real charges were involved. One staff creation attempted its normal verification email; the unconfigured local SMTP connection refused it, and no email was delivered. This is server-side behavioral verification, not evidence of successful Safaricom/Paystack delivery or mobile browser behavior.

## Reproduced before the fix

- Two different pending monthly payments, both with successful HTTP callbacks at the same time, returned HTTP 200. Both payment records covered January 1–February 1, 2027; the subscription ended February 1. One of two paid months was lost.
- Two independent database copies of the same successful payment passed to activation concurrently consumed two promotion redemptions for one payment.
- While verifying the transaction change, the server's America/Santiago time zone moved a February 1 UTC renewal to March 4. The old local-time calendar arithmetic was environment-dependent.
- Code review found unconditional clearing of staff adjustments on completion, including changes added after checkout. Activation also copied the old payment headcount over the current team count.

## Changes

Activation now re-reads the payment inside a snapshot/majority MongoDB transaction, serializes with staff billing through the shop revision, and commits the subscription period, promotion redemption and payment period marker together. Only confirmed successful payments can activate. Missing subscriptions fail without committing a promotion redemption. Repeat processing reads the committed marker and does not extend again.

New charged and free payment records snapshot the IDs of accrued staff adjustments priced into that invoice. Completion removes those lines only, preserving newer adjustments. Existing pending payments without the snapshot use their creation time as a compatibility cutoff; this cannot reconstruct an exact historical invoice snapshot. Headcount is recounted from active users during activation.

Billing calendar arithmetic uses UTC and clamps to the destination month's last day. It preserves the input time of day. A clamped February renewal subsequently renews from that clamped date; this change does not introduce a separate permanent billing-day anchor.

## Observed after the fix

| Scenario | Observed result |
| --- | --- |
| Two different monthly payments, concurrent HTTP success callbacks | HTTP 200/200; periods January 1–February 1 and February 1–March 1; subscription March 1; two redemptions |
| Same successful payment, concurrent activation from separate DB documents | One period extension; one promotion redemption |
| Same callback twice concurrently, then delivered again | All accepted; one extension and one redemption |
| Two concurrent free checkout requests with different intent keys competing for one promo slot | HTTP 201/400; one successful payment, one failed payment; one extension, one redemption |
| Invalid persisted payment plan causes subscription validation to fail after promotion claim | Subscription unchanged; redemption count zero; no payment period marker |
| Repair fixture plan and retry that interrupted activation | Exactly one extension and redemption |
| Staff charge created after checkout | Included old line removed; newer KES 130 line retained |
| Payment stored count 1 while actual team became 2 before completion | Subscription saved count 2 |
| Successful callback racing actual HTTP staff creation from 3 to 4 users | HTTP 200/201; actual and saved counts both 4; one KES 260 adjustment retained |
| Cancelled callback (1032), followed by direct activation attempt | Cancelled record retained; no extension or redemption |
| Callback with incorrect secret | HTTP 401 |
| Monthly January 31, 2027 at noon UTC | February 28 at noon UTC |
| Monthly February 1, 2027 at midnight UTC | March 1 at midnight UTC |
| Quarterly January 31, 2027 at noon UTC | April 30 at noon UTC |
| Yearly February 29, 2028 at noon UTC | February 28, 2029 at noon UTC |

Modified JavaScript files also passed syntax checking and the diff passed whitespace checking. No test suite was run.

## Limits and further work

Requires transaction-capable MongoDB, as existing staff billing and sales paths already do. This pass used one replica-set node, not failover or sustained load. No pricing migration, production deployment or real payment was performed.

Still needed: provider sandbox initiation and callback/reconciliation flows, real-phone UX, referral reward concurrency, older pending-payment recovery and billing behavior when several independent pending invoices contain the same accrued charges. Provider initiation currently precedes persistence of its payment intent; concurrent retries before the intent exists need a separate review. Seat-addition legacy activation is a separate path and is not changed here. Referral reward processing remains after the activation commit; it is not included in the transaction or certified by these checks.
