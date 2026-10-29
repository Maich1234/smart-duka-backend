# Concurrent sale void review — 29 October 2026

## Reproduction

Used the actual Express HTTP API, production controller/services, synthetic owner and staff accounts, and an isolated MongoDB 7.0.24 replica set with declared indexes. The staff account had void_sale permission. No existing test suite, production data or payment provider was used.

A temporary runtime-only barrier held the first two sale reads until both transactions had read the same completed sale. This guarantees the overlap instead of relying on request timing. It did not replace database writes or transaction behavior. Later retry reads were not held. The ten-request scenario held all ten initial reads. Instrumentation is not part of production source.

Before the change, two distinct users with distinct intent keys returned HTTP 200 and HTTP 500 (MongoDB WriteConflict). Stock correctly returned from 8 to 10, not 12, but the losing user received an incorrect server-error experience.

## Change

Use session.withTransaction for voiding instead of a manually started/committed transaction. A transient conflict retries the complete operation against fresh documents and rechecks the sale status. Stock restoration, credit reversal and sale status/actor changes remain in that transaction; no HTTP response or external effect occurs inside its retry body. Operational sale/credit errors are handled after automatic rollback, and the session is ended once.

The successful request returns 200. A different request that loses the race returns the existing 400 message, "This sale has already been voided." A same-key replay of the successful request retains its original 200 response. Different users are not deduplicated by the idempotency middleware; transaction isolation and the status recheck provide the cross-user protection.

## Observations after restarting the API with the fix

| Scenario | Observed result |
| --- | --- |
| Owner and permitted staff void the same stock sale | 200/400; quantity 8 → 10 once; final status voided |
| Same race for an untracked service | 200/400; quantity unchanged at 10; sale saved as voided once |
| Same race for an unpaid KES 200 credit sale | 200/400; stock 8 → 10; outstanding 200 → 0; one CREDIT_SALE_REVERSAL row |
| Ten requests alternating the two accounts, all reading before writes | One 200, nine 400 already-voided responses; no 500; stock restored once; one debt reversal |
| Inspect voidedBy after all four races | Matches the actor recorded in the winning response; losing requests do not overwrite it |
| Repeat winning request with its original intent key | Original 200 replay; stock remains 10 |
| Repay KES 40 of another KES 200 debt and try voiding | 400 DEBT_PARTLY_REPAID; sale still completed, stock 8, outstanding 160 |

Changed controller passed JavaScript syntax and whitespace checks. No migration or client contract change is required. No production deployment was performed. This review covers same-sale void contention; real multi-region failover, simultaneous refund/provider reversal interactions and physical-client UI behavior are not certified by it.
