# Delayed payment confirmation and recovery — 29 October 2026

## Method and reproduced failure

Used the actual Express API with a fresh MongoDB 7.0.24 replica set and real model indexes. Submitted synthetic authenticated M-Pesa callbacks and locally HMAC-signed Paystack-shaped webhook requests. Synthetic keys were stored using the production encryption function in the isolated PlatformConfig. These requests exercised the production parsing, authentication, database writes and activation code; they were not deliveries from either provider. No provider account, real charge or production data was used. No existing test suite was run.

Before the change, polling a three-minute-old pending payment persisted `timeout`. A subsequent successful callback returned HTTP 200 but left that payment timed out, with no subscription extension or promotion redemption. The callback handler only claimed pending records. Inspection also found that stale reconciliation writes could downgrade success, and that bank verification accepted missing amounts and did not validate currency.

## Behavior changed

- Polling is read-only: elapsed waiting time does not change a payment into a stored timeout. Provider-reported failures/timeouts remain meaningful.
- Authenticated late success can supersede pending, timeout, cancelled or failed status. Guarded database updates prevent delayed failure results from overwriting confirmed success or a committed service period.
- Re-delivery can finish a previously confirmed payment whose activation failed. Incomplete callback processing returns HTTP 503 instead of acknowledging completion. This permits provider retries; actual delivery/retry behavior is not established by these local checks.
- Client payment responses remain pending until the subscription's period marker commits. They include a confirmation/activation message rather than presenting an unfinished activation as complete.
- Confirmed M-Pesa/free activations can be repaired by the authenticated recheck path without requiring another provider call. For bank payments, a new `providerConfirmedAt` marker is recorded only after validating amount and currency. Older unfinished bank records without that marker still require verification; already activated historical payments are unaffected. The activation service enforces this guard too.
- Paystack webhook and reconciliation validation require an integer amount in minor units matching the invoice and a matching currency. Missing values fail validation. M-Pesa does not pass through the Paystack-specific validator.
- Callback lookup includes the provider as well as its reference. M-Pesa SMS recovery only considers M-Pesa attempts.

## Observations

| Manual scenario | Observed result |
| --- | --- |
| Poll a three-minute-old pending attempt | HTTP 200, still pending; no expiry write |
| Deliver success afterward | Subscription extends once; one redemption |
| Deliver success for timeout/cancelled/failed fixtures | Each becomes success and receives one service period |
| Deliver cancellation after success | Success, receipt and service period preserved |
| Cancellation, success and polling at the same time | HTTP 200/200/200; final success; one period and redemption |
| Cause subscription validation failure during callback activation | HTTP 503; provider confirmation retained; no period or redemption committed |
| Poll that unfinished activation | Pending with “Payment confirmed. We are finishing your subscription activation.” |
| Repair fixture and redeliver callback twice | Success; exactly one extension/redemption |
| Repair fixture and use authenticated recheck instead | HTTP 200; client success; exactly one extension/redemption, without provider credentials |
| Signed bank success after timeout | Activates; verified-confirmation timestamp persisted |
| Signed bank amount 100 instead of 29000 | Failed, no activation/redemption |
| Signed bank confirmation with null amount | Failed, no activation/redemption |
| Signed bank confirmation with NGN instead of KES | Failed, no activation/redemption |
| Signed bank confirmation with null currency | Failed, no activation/redemption |
| Invalid bank signature | HTTP 401, payment remains pending |
| Conflicting malformed bank confirmation after valid success | Existing success, receipt and period preserved |
| Bank and M-Pesa records have the same provider reference | Bank webhook updates only bank record; M-Pesa remains pending |
| Direct activation of old unfinished bank success without verification marker | Rejected before extending subscription |
| Malformed bank confirmation for that old unfinished record | Failed with zero redemptions; a subsequent valid signed confirmation activates once |
| M-Pesa SMS recovery when only a bank attempt has the matching receipt | HTTP 404, bank payment not adopted |

Core callback/bank cases were repeated after the verified-confirmation marker was added. The final source was restarted for SMS-provider isolation and callback-failure → pending response → recheck recovery. All changed JavaScript passed syntax checking and the diff passed whitespace checking.

## Limits and remaining work

No deployment, database migration or live payment was performed. This does not certify provider initiation, actual provider signature delivery, provider retry schedules, refunds, disputes, real-phone behavior, failover or load. The browser's own polling deadline and retry UX are unchanged; removing a server-side false timeout does not remove the browser's deadline.

Concurrent initiation can still reach a provider before the unique payment intent is persisted. That separate race remains open; this PR prevents delayed confirmations from being discarded and protects recorded results, not duplicate provider initiation. Legacy seat-addition activation/cleanup and referral reward concurrency also remain separate review areas. Existing historical success without a period marker is not proof of a valid bank amount: the new guard intentionally requires verification before granting that unfinished service.
