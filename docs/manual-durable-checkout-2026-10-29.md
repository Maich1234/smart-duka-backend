# Durable subscription checkout review — 29 October 2026

Actual Express HTTP requests and database inspection used an isolated MongoDB 7.0.24 replica set, real indexes and synthetic accounts/configuration. M-Pesa dispatch/query results were controlled at the provider boundary. Bank dispatch used a counting wrapper around the production local initialization method. No live charge, production data or existing test suite was used.

A shop-level transaction serializes checkout reservation across different intent keys and providers, including free activations. Pending, legacy timeout, and successful-but-not-yet-applied subscription attempts are returned for recovery. Seat-addition payments are excluded. Only the reservation creator dispatches the provider. Provider calls remain outside retryable transactions. Owner-only GET /api/v1/subscriptions/checkout returns the existing unfinished attempt or null. Status/recheck/reconciliation responses include the actual provider.

| Operation | Observed result |
| --- | --- |
| Ten simultaneous requests with distinct keys alternating M-Pesa/bank | One 201 and nine 200; same payment ID; one saved record and one total provider dispatch |
| Free-promo request while charged checkout pending | Returns existing pending payment; no promo redemption or new dispatch |
| Timeout record followed by a different-provider request | Existing ID returned; no new dispatch |
| Explicitly failed record followed by new intent | New payment created with HTTP 201 |
| Fresh 100% promotion, no unfinished checkout | HTTP 201, success, amount 0; recovery endpoint returns null |
| Staff requests recovery | HTTP 403 |
| Unauthenticated recovery | HTTP 401 |
| Different shop's owner requests recovery while first shop is pending | HTTP 200, checkout null |

The companion web review exercises refresh/reopening, lost-response replay, server-only recovery, damaged/denied storage, and clearing on confirmed success through actual React components and this API. See the web repository's manual-durable-checkout-2026-10-29.md.

Existing MongoDB transaction support and payment intent indexes remain required. No new index or production migration was applied. Legacy multiple outstanding attempts are recovered one at a time; completed independent extensions are still allowed. Reservation-before-dispatch interruption can still require support: uncertain attempts must not be blindly redispatched. This prevents overlapping application checkout starts in the observed scenarios; it does not guarantee exactly-once delivery by a provider or certify real sandbox/device behavior. Deploy backend before the companion web change.
