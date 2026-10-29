# Concurrent refund and void review — 29 October 2026

## Method and reproduced faults

Exercised actual Express HTTP endpoints, production services and Mongoose models against an isolated MongoDB 7.0.24 replica set with initialized indexes. Used synthetic owners, permitted staff, shops, products and payment configuration. No existing test suite, production database or live money was used.

For cash correction races, a temporary runtime barrier held transaction reads until both requests (or all ten) read the completed sale. Database writes and driver transactions remained real. For M-Pesa, the unchanged service's outbound fetch boundary returned controlled OAuth/reversal responses, held responses to force overlap, lost a response, or delivered a real local HTTP callback before returning. This verifies application ordering, not Safaricom connectivity or actual payouts.

Before the change, two cash refunds returned 200/500 (WriteConflict), with stock protected by rollback. More seriously, two users' M-Pesa refund requests both invoked the reversal service before either sale was saved as pending: two outbound requests and two 200 responses. No real double debit was performed.

## Changes

- Cash refunds use a retryable transaction and recheck sale state/debt before restoring stock. Only completed sales can be refunded in cash.
- M-Pesa refunds reserve the sale atomically as refund_pending before external dispatch. Different users/keys, voids and cash refunds compete for the same sale state. Only the reservation winner dispatches.
- Preserve uncertain refunds after network or metadata failures (202). Elapsed time and queue timeout do not authorize another payout or cash fallback. A definitive failure callback permits a new attempt.
- New callback URLs include sale ID and a unique attempt ID, protected by the existing secret. Callbacks can correlate before provider metadata is saved. Primary-key sale lookup requires no new index. Legacy reference-based routes remain supported.
- Result settlement uses a retryable transaction, matching the current attempt/status and any known references. Supplied success amounts must match the dispatched rounded amount. Malformed result codes and missing references cannot release a reservation. Old attempts cannot settle a newer one. Duplicate callbacks do not restore stock twice.
- Timeout callbacks update an explanatory message without marking the payout definitively failed. They cannot overwrite a newer attempt or a settled state.

## Observed outcomes

| Scenario | Observed result |
| --- | --- |
| Two cash refunds on the same sale | 200/400; stock 8 → 10 once; no 500 |
| One void and one cash refund, both read before writing | 200/400; one final correction, stock restored once; both void-winning and refund-winning runs observed |
| Two refunds on an untracked service | 200/400; no stock movement |
| Ten cash refunds | One 200, nine 400; one restoration |
| Two concurrent M-Pesa refunds with response held | One outbound reversal; one accepted request, one 400 |
| Ten concurrent M-Pesa refunds | One outbound reversal, one 200, nine 400 |
| Void or cash fallback while M-Pesa response held | Both rejected 400; pending reservation remains |
| Success callback before initiation reply | Initiation returns confirmed refunded state; stock restored once |
| Controlled lost provider response | 202; pending retained; new-key retries/cash fallback blocked even after requestedAt moved to 2020; late callback settles |
| Controlled provider-metadata write failure | 202 with reservation; callback by sale/attempt settles without stored references |
| Queue timeout followed by late success | Remains pending with stock 8; success later refunds and restores to 10 |
| Definitive failure then new attempt, followed by old-attempt success | New attempt remains pending and stock unchanged until its own success |
| Duplicate simultaneous success callbacks | One final refunded state; stock remains 10 |
| Wrong callback secret | 401 |
| Wrong known references, missing result code, success with wrong amount | Ignored; sale remains pending |
| Legacy callback without sale/attempt path segments | Still settles a legacy pending record using its stored provider references |
| Refund unpaid KES 200 credit sale | 400 CREDIT_SALE_UNPAID; debt 200 and stock 8 unchanged |

After adding result-code validation, restarted the API and repeated cash/mixed races, ten-provider-start contention, callback validation, simultaneous callbacks, metadata failure and legacy compatibility. Changed JavaScript passed syntax/whitespace checks. The companion web change was rendered via ReactDOM/JSDOM against this API: a 202 refund displays amber, a completed cash refund displays green, and a stored pending sale has no second-refund button. TypeScript and production web build passed (74 routes).

## Deployment and limits

Deploy backend before the companion web message update. No index replacement, production migration or deployment was performed. Optional refund.attemptId supports new requests; legacy records/routes remain readable.

The reservation deliberately favors preventing a second payout. A crash before dispatch, configuration/decryption failure after reservation, a rejected initiation without a definitive callback, or an irretrievable provider outcome can require manual provider reconciliation/support. An automated refund-status inquiry/support resolution UI is not implemented here. Do not clear uncertain legacy reservations merely because they are old.

Callbacks retain the existing acknowledge-first HTTP pattern; this pass does not make callback processing durable across process termination. Provider sandbox execution, contradictory provider results, real reversals, multi-region failover, physical-device behavior and whole-system security certification remain outstanding. No claim of exactly-once delivery by Safaricom is made.
