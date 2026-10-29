# Payment initiation concurrency and interruption review — 29 October 2026

## Method

Ran the production Express API against an isolated MongoDB 7.0.24 replica set with real indexes. Issued actual concurrent HTTP payment requests and inspected persisted payment/subscription records. Used synthetic shop owners, configuration and keys throughout. No existing test suite was run, and no live payment or production database was touched.

For bank initialization, a logging wrapper called the unchanged production bank provider and recorded its returned references. That provider only prepares checkout locally; no Paystack charge was made. For M-Pesa failure/ordering scenarios, temporarily substituted the provider's charge method inside the isolated runtime to return a controlled result, throw an ambiguous network error, or deliver an HTTP callback before returning. These simulate the provider boundary; they do not verify Safaricom connectivity, prompt delivery, debit behavior or callback delivery. Selected database-write faults were also injected in the runtime only, after reservation, to inspect recovery responses. None of this instrumentation is part of production source.

## Reproduced before the fix

Two simultaneous requests with the same intent key both invoked the production bank initialization method and generated different references. HTTP responses ultimately pointed at one saved payment due to the unique index, but the provider had already been invoked twice. The losing initialization was not represented by the saved payment. This confirms the dispatch-ordering race, not that two real debits occurred.

## Changes

- Validate the selected provider's local configuration before reservation. Bank checkout no longer depends on an M-Pesa callback URL.
- Reserve the payment under the existing unique `(shop, idempotencyKey)` index before provider dispatch. Only the insertion winner calls the provider; retries and concurrent callers return the reserved attempt.
- Preallocate the bank reference and preserve the publishable key, currency and cycle in replay responses, so a replay has the checkout fields the browser needs. No provider secret is returned.
- Keep uncertain provider results as pending, return the saved payment ID and do not automatically dispatch again. HTTP 202 means the result is still awaiting confirmation, not that money was received.
- Retain the reserved payment ID in the response even when storing provider metadata or recording the uncertainty state fails after dispatch.
- Include the attempt ID in the new M-Pesa callback path, with the existing shared-secret check. This lets an early callback or a callback after an ambiguous initiation response locate its reserved attempt before the provider reference was saved. The callback must match that attempt's provider/reference; a known reference cannot be replaced by another one. The old callback path remains supported.
- Final initiation metadata updates do not overwrite payment status. An early successful callback remains successful, with its committed service period.

## Manual observations

| Scenario | Observed result |
| --- | --- |
| Two concurrent bank requests with one intent key | HTTP 201/200; one provider initialization, one saved payment, matching returned IDs/references |
| Ten concurrent bank requests with one key | One 201 and nine 200; one initialization, one payment, one returned reference |
| Ten concurrent M-Pesa-shaped requests with one key, controlled provider boundary | One dispatch; one saved attempt; all responses share its ID; reservation existed before dispatch |
| Bank retry after initial response | Same ID/reference/public key; no second initialization |
| Bank initiation without configured M-Pesa callback base URL | Succeeds using its own configuration |
| Bank configuration disabled | HTTP 503; no reservation or provider initialization |
| Ambiguous M-Pesa initiation error, then same-key retry | HTTP 202/200; same ID, one dispatch; pending/uncertain record retained |
| Successful HTTP callback after that ambiguous result | Reserved attempt becomes successful with one service period |
| HTTP success callback before provider returns | Callback completes; initiation response reports success; metadata update preserves success; replay does not dispatch again |
| Wrong callback secret with a valid attempt ID | HTTP 401, before valid confirmation |
| Correct callback secret with attempt A ID but attempt B's known reference | HTTP 200 ignored; both attempts remain pending and references unchanged |
| Old callback path without attempt ID | HTTP 200; correlated legacy payment activates normally |
| Same key used by two shop owners | Separate payment IDs and provider references; one initialization per shop |
| Owner reads another shop's payment | HTTP 404 |
| Two headerless requests | Two distinct IDs/references, one initialization each; they are separate attempts |
| Concurrent same-key free-promotion requests | One payment, one redemption, no provider initialization |
| Controlled metadata-write failure after provider returns | HTTP 202 with the reserved ID; same-key retry returns that ID without another dispatch; later callback activates |
| Controlled provider error plus failure to record uncertainty | HTTP 202 still includes the reserved ID; retry returns it; no second dispatch |

After the callback path and reference guards were finalized, restarted the app and repeated mismatched-reference rejection, early success, secret rejection, ambiguous initiation recovery and old-path compatibility. After the storage-error response change, restarted again and exercised both storage-fault branches. Changed JavaScript passed syntax checking and the diff passed whitespace checking.

## Deployment requirements and limits

The existing unique shop/intent-key index must be present in the deployed database. No new index or production migration was applied in this pass. New fields are optional for older rows; old callbacks and payments remain compatible.

This guarantees one application dispatch per persisted shop/intent key in these checked scenarios. It does not provide exactly-once provider delivery, certify bank reference behavior under real charges, or deduplicate different keys. Headerless requests deliberately receive new keys. Browser rapid taps, closing/reopening checkout, and retries that generate new keys still need a client-side review and physical-phone checks.

A process can stop after reservation but before dispatch; the same-key replay deliberately does not blindly send again. If an initiation result is lost and no callback/reference arrives, provider verification or support remains necessary. This change does not certify every interrupted payment can automatically recover, and it does not delete uncertain attempts or assume no money was taken.

No deployment, provider sandbox run, real charge, failover/load exercise or whole-system security certification was performed. Device UX, legacy seat-payment cleanup, referral reward concurrency and overlapping independent invoice adjustments remain separate review work.
