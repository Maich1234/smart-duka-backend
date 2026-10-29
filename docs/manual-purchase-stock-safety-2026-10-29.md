# Purchase and stock safety review — 29 October 2026

## Method and reproduced faults

Used actual Express HTTP endpoints, production services and Mongoose models with an isolated MongoDB 7.0.24 replica set and initialized existing indexes. Synthetic owners, staff, products and purchases only. No existing test suite, production database, live provider or physical device was used.

Before changes:

- Two approval requests that both read the pending purchase returned 200/500 (WriteConflict). Stock was applied once, but one user received a server error.
- Receiving 0.005 units returned 201 and stored 0.01 units because stock arithmetic used two-decimal money rounding.
- Staff with edit_product but without edit_product_stock could PUT quantity=999 successfully. The response also exposed the stored costPrice (73), despite read endpoints stripping costs.

## Changes

Purchase creation, editing, approval and cancellation use retryable transactions. Every attempt reloads/rebuilds its mutable state. Errors leave the transaction before becoming HTTP responses, and audit events occur after commit. Editing checks cancelled status again inside the transaction, preventing a stale preflight read from resurrecting a cancelled purchase.

Receipt quantities use three-decimal stock arithmetic independently of two-decimal cost arithmetic. New purchase inputs require at least 0.001 and at most three decimal places; finer inputs are rejected rather than silently rounded. Weighted-average cost's quantity denominator uses the same stock precision; cost output remains rounded to cents.

Purchase reversal reconstructs the remaining net receipt impact from that purchase's stock journal, including earlier edits/reversals. It removes the originally received product/variant quantities even if type/tracking settings changed. A reference lookup index is declared for this query. Old purchases with no journal retain the previous best-effort item fallback; deleted products/variants are still skipped. Costs are not retroactively unwound, preserving the existing costing policy.

Product updates enforce edit_product_stock for changes to standard or variant quantities. Unchanged quantity fields can accompany ordinary staff forms; omitted variant quantities preserve the stored quantity instead of defaulting to zero. Metadata edits still work. Staff create/update/stock mutation responses use the same cost/commission sanitizer as product reads.

Stock recount updates conditionally match the quantity read by the server. Product-form saves guard the read timestamp and supplied stock fields, including the full variant ID/quantity sequence. A conflicting write returns 409 STOCK_CHANGED or PRODUCT_CHANGED and an instruction to refresh instead of overwriting an intervening sale.

## Manual observations after changes

| Operation | Observed result |
| --- | --- |
| Two simultaneous approvals, both initial reads held before writes | 200/400; quantity 10 → 12; one purchase movement |
| Ten approval requests | One 200, nine 400; one receipt applied |
| Disable tracking after receipt, then two simultaneous cancellations | 200/400; original received stock removed once (12 → 10) |
| Two independent simultaneous receipts of 2 and 3 units | Both 201; quantity 10 → 15 |
| Receive 2 while a concurrent sale of 1 commits after receipt's read | Both succeed; quantity 10 → 11 after transaction retry |
| Receive/cancel 0.005 units | Exactly 0.005 received, then 0; 0.0005 input rejected 400 |
| Edit quantity 2 → 3, then cancel | Net journal impact correctly removed; starting balance restored |
| Edit and cancel the same purchase concurrently | Edit 200 followed by cancellation 200 in the observed ordering; final cancelled and original balance restored |
| Invalid second product in a receipt | 400; no purchase inserted and stock unchanged |
| Staff without stock permission PUT standard quantity or variant quantity | 403; no unauthorized quantity change |
| Staff edits name and variant label, omitting variant quantity | 200; existing quantity preserved; stored variant cost retained |
| Authorized staff PATCH stock | 200; response excludes costPrice |
| Staff create/update product | Successful permitted actions; response excludes costPrice and commission |
| Completed-purchase edit by staff without inventory-update permission | 403 |
| Hold recount request after read; commit a sale; resume recount | 409 STOCK_CHANGED; sale's quantity 9 preserved |
| Hold a valid variant-form save after read; sell a variant; resume save | 409 PRODUCT_CHANGED; sold quantity preserved |

An initial owner-variant fixture omitted required costPrice and received 400 during validation. It was discarded as a concurrency observation and repeated with a valid owner payload to verify 409 after the intervening sale. No production code change was based on that invalid fixture.

Race barriers and provider-free fixture instrumentation existed only in the isolated runtime. For recount/variant cases a runtime query wrapper held the initial read while an actual sale committed; the conflicting request then continued. Changed JavaScript passed syntax/whitespace checks. The new non-unique journal lookup index was added after the behavior walkthroughs; it does not supply a correctness constraint. No existing suite ran.

## Deployment and remaining limits

Backend-only change. No production deployment, historical data repair or manual production index command was performed. The declared non-unique {shop, refModel, refId} index should be created through the existing model/index deployment process; behavior does not depend on it being unique or present.

The recount guard detects changes during the server request. It does not compare against the quantity first displayed when a user opened a form; clients do not yet submit that baseline/version. Metadata-only edits use the existing millisecond updatedAt field, not a universal revision counter. Purchases without movement history, quantities already corrupted by prior rounding, deleted variants, retroactive cost reconstruction, full inventory journal parity for sales/manual adjustments, and physical-client behavior need separate work. This is not whole-system security certification.
