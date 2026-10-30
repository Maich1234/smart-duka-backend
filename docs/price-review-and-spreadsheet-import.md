# Price review and spreadsheet import

Owner-only product review covers zero/missing/negative selling prices, below-cost prices, flexible floors below cost, missing costs and missing variants. Configurable parents expand into variant rows. Bundle costs derive from same-shop components; bundles do not duplicate component stock exposure. Services can have zero purchase cost. Current exposure is positive stock times cost-minus-current-price; recorded sales shortfall uses saved sale cost and after-discount subtotal over a bounded rolling period. Void/refunded sales are excluded; estimated/unknown costs remain separate. These are gross shortfalls, not net business losses.

Price create/edit and purchase cost updates record actor, time, before/after pricing and source inside the same write transaction. History begins with this release. Historical actors are not invented. The last editor is not automatically responsible for a loss. AI snapshot v3 includes this report, cache fingerprints include pricing digest, daily fallback reports figures and chat has a scoped pricing tool.

PDF exports include all current alerts up to an explicit 10,000-row ceiling, period figures, last recorded editor and top ten historical shortfall groups. A mandatory QR points to /verify/:token. This verifies a signed origin/summary/currency, not every byte or row of a separately edited PDF. Deploy the companion web route and correct PUBLIC_WEB_URL. The embedded Latin font and its redistribution license are in src/assets/fonts.

## Excel import

GET /products/import/template?format=xlsx (or xls), POST multipart /products/import/preview, POST /products/import/:batchId/commit. All owner-only. Writes use existing paid-shop gate. Maximum file 5 MB; 2,000 products and 2,000 rows on each supporting sheet; up to 25 MB expanded ZIP content. SheetJS 0.20.3 comes from the official maintained tarball. Parser loads only when import/template is used. Templates include Products, Variants, Bundles and Instructions sheets. Adds only; no existing product overwrites.

Preview validates against Joi and Mongoose, rejects formulas/macros/unsupported sheets and compressed-size abuse, detects name/SKU/barcode duplicates and reports row errors. Below-cost entries require acknowledgement. Normalized preview payload lives in an owner/shop-scoped batch with 24-hour TTL. Commit accepts only the batch identity and acknowledgement, rechecks catalogue conflicts and components, and atomically inserts all products/history and marks the batch committed. Retries use the same batch. A per-shop write lock serializes product create/edit/delete and import commits; purchase stock writes retain normal product transaction conflict protection. Production needs schema indexes applied via the existing deployment/index maintenance process.

## Verification, 30 October 2026

No existing test suite was used. Independent local scenarios exercised maintained XLS/XLSX parsing, all product types, leading-zero identifiers, case-normalized duplicate identifiers, formula rejection, malformed files, 2,000 products (under one second in this environment), oversized row count, physical row numbering across gaps, missing variant costs and below-cost warnings. Product validation and API application modules load successfully.

The production aggregation pipeline was evaluated with an in-memory Mongo operator engine and synthetic catalogue/sales. Expected potential 330, saved-cost gross shortfall 40, estimated shortfall 20 and one unknown-cost line matched. Variant parent zeros were ignored, bundle derived cost was 200 with stock exposure excluded, other-shop rows excluded, and fixing a current price retained the historical loss. This is not a real MongoDB transaction or query-plan check.

Generated and visually reviewed a multi-page PDF. Fixed newline loss, footer pagination and font substitution; signed summary tampering rejects. Deterministic AI fallback includes figures. Web/admin production builds and web/mobile/admin TypeScript pass.

Outstanding: local MongoDB exits code 100 under environment restrictions. Automatic approval review rejected uploading source to the connected Vercel QA sandbox, so real MongoDB transaction, rollback, tenant HTTP and concurrency scenarios were not executed. A browser executable was also unavailable and its download failed, so signed-in browser/native-device walkthroughs remain outstanding. Live Gemini/Safaricom calls and production customer records were not used. Keep PRs draft until those checks pass; no production merge/deploy was performed.
