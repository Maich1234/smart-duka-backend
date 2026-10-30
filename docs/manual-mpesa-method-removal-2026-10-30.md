# M-Pesa method-removal follow-up, 30 October 2026

## Finding and behavior

Sale creation rejected the removed method before looking up an existing confirmed payment. A customer could finish an already-started STK payment after owner removal, leaving the sale blocked by PAYMENT_METHOD_UNAVAILABLE. Conversely, the fresh STK initiation controller did not check the owner's enabled method list at all.

Fresh initiation now requires enabled M-Pesa, after existing-key lookup so recovery of an already-sent request remains available. Sale creation resolves any shop-scoped payment reference first. Only a successful existing M-Pesa transaction can settle a sale after method removal. Plain unverified receipt text, pending/failed/cancelled/timed-out payments, other-shop transactions, already-linked transactions and other removed method keys cannot use this exception. A removed method's settlement receipt is labelled M-Pesa.

Existing in-transaction success/amount checks and conditional unclaimed sale ownership remain unchanged. The patch does not introduce a new charge, bypass sale permissions/subscription gates, or mutate historical labels.

## Verification and limits

An independent temporary walkthrough invoked the actual production sale service and initiation controller with synthetic model-read responses. Stopped at the transaction boundary rather than pretending to commit a sale. Verified removed fresh requests reject; confirmed same-shop unused payments reach that boundary by transaction ID or matched receipt; unverified, non-success, foreign-shop, already-linked and wrong-method references reject; existing pending/success initiation keys remain recoverable. All model lookups were checked for shop scoping. Changed JavaScript and whitespace checks passed. No existing test suite or live payment was used.

Full replica-set HTTP verification was attempted, but local MongoDB startup failed with exit 100 and open: Operation not permitted, both with /dev/shm and temporary storage. No sandbox escalation was requested. This run therefore does not certify real database commit/concurrency behavior or provider callbacks. No migration, native build, merge or deployment was performed.

## Separate pre-existing risks identified by inspection

Fresh STK initiation sends the external request before the unique transaction insert arbitrates an idempotency-key race. Two simultaneous first attempts can reach the provider before one insert loses. Also, the status endpoint marks pending requests timed out by age while callback handling ignores non-pending rows, creating a late-confirmation reconciliation risk. Those durability/reconciliation paths are not rewritten by this method-removal patch. The existing atomic sale claim protects against a second sale for one transaction; that is not proof of at-most-one provider prompt.
