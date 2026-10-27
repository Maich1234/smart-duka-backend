# Transaction and session hardening

These changes are prepared on the feature branch, not a production deployment.

## Deployment prerequisites

1. Back up and use a dedicated staging database for the first rollout.
2. Run `npm run sync-indexes` with the intended database configuration **before accepting new sale traffic**. The additive index script must successfully create SaleOperation's unique `(user, key)` index and RefreshToken's session lookup index. Do not use `--prune`. Durable duplicate-sale prevention depends on the unique index; application compilation does not create it in production.
3. Deploy backend before the updated web checkout, then exercise legacy JWT refresh and fresh login from both mobile and web. Legacy access JWTs lack session identity and receive 401; clients with a valid refresh token can upgrade. Older clients without refresh support must sign in again.
4. Verify lost-response retries and concurrent same-key submissions against a real replica-set database. Unit mocks do not demonstrate MongoDB rollback or unique-index concurrency behavior.

## Resulting behavior

- Keyed sales persist an immutable request digest and result in the same transaction as stock, sale and credit writes. The record has no TTL, so a delayed retry remains recoverable after HTTP replay records expire. Reusing a key with different sale content returns 409.
- Unkeyed legacy clients remain compatible, but cannot receive this operation-key guarantee. Previously committed sales without operation records cannot be retroactively deduplicated.
- M-Pesa sales require the requested transaction amount to match the server-calculated sale total. Callbacks validate the actual amount against Daraja's existing ceiling-to-whole-shilling request policy. Paid amount and rounding difference are retained on the sale. Manual/unconfigured M-Pesa without a linked transaction remains a separately recorded, unverified payment method.
- Callback status is saved before success acknowledgment; persistence failures return 503. Provider retry is not a substitute for reconciliation when a callback is missing.
- Access tokens identify a refresh session shared across rotations. Protected requests check that a live session exists; logout, password-change and device replacement revocation therefore affect access tokens too. Owners retain independent device sessions. Staff replacement no longer depends on optional device metadata.
- Middleware binds new HTTP replay records to method, route and canonical body digest. Old replay records without a digest remain readable during transition.
- Application access logging excludes full URLs to avoid exposing URL bearer secrets. Hosting/proxy logs need separate configuration review and any exposed secrets need rotation.

## Optimization and limitations

Session checks use an indexed existence query instead of loading refresh-token documents. Durable results are prepared once per sale transaction and reused for replay; financial side effects and negative-stock alerts are not repeated during replay. Product form serialization was extracted into a pure, directly testable web module. Existing variant IDs survive web edits, fractional weighted/refillable stock and zero alert thresholds are preserved, and unknown/duplicate variant IDs are rejected by the backend.

Still required: authenticated physical-device checks, provider sandbox integration, real concurrent staff-login/sale tests, payment rounding display/receipt review and production index verification. A full web/mobile parity completion is a separate tracked item; quotation conversion UI, opening balances/reversals and permitted staff customer/credit/quotation screens remain incomplete.
