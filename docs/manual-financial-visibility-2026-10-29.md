# Financial response visibility review — 29 October 2026

## Method and findings

Actual HTTP requests exercised the production Express API, Mongoose models and initialized indexes against an isolated MongoDB 7.0.24 replica set. Synthetic owners, staff, products, suppliers and purchases only. No existing test suite, production database, live payment or physical device was used.

A staff account with view_purchases but without view_purchase_prices received purchase stats totalSpend=74, a recent row unitCost=37, the full cost analytics summary and supplier spend/recent purchase costs. Staff sale creation also returned its accounting unitCost=37. UI hiding did not protect those APIs.

After adding the response helpers, a deliberately seeded legacy IdempotencyRecord still replayed the old unfiltered sale unitCost=37. That separate replay bypass was reproduced and fixed rather than treating fresh responses as sufficient verification.

## Policy and changes

- A shared purchase presenter handles list/detail/mutation/dashboard/supplier rows. Staff without purchase-price permission retain operational counts/quantities but do not receive totals, unit costs or additional-cost amounts. All-cost analytics require that permission. Owners and explicitly permitted staff retain price access.
- A sale presenter removes accounting unitCost, costTotal and costEstimated from staff responses, including normal/search lists, detail, own sales, creation, void/refund and quotation conversion. Internal stock movements are omitted. Commission on a sale is visible to staff only when the shop enables visibility and that sale belongs to them. Historical commission remains visible when eligibility has changed, matching the existing commission-history policy. Owners retain accounting fields.
- Saved mutation replies use the same current presentation policies for sales, quotation conversion, purchases and products. Case-insensitive routes and trailing slashes are covered. This does not re-execute the mutation.
- A request key cannot replay another method/path's result. Completed cached replies exposing a different shop are refused. Corrupt cached JSON returns an actionable 503 without rerunning the operation.
- Missing populated seller records no longer cause an ownership-check exception; restricted staff are denied.
- Web summary types mark redacted cost fields optional. Existing screens already hide them without permission; the type update aligns the API contract without altering display behavior.

## Manual observations

| Request / scenario | Observed result |
| --- | --- |
| Restricted staff purchase stats | 200; counts retained, totalSpend and recent purchase costs absent |
| Restricted staff cost analytics | 403 |
| Restricted staff supplier detail | Operational stats retained; spend/average and recent costs absent |
| Grant purchase-price permission | Stats/supplier costs restored; analytics 200 |
| Revoke permission after a priced purchase response was saved, then replay | Costs omitted; stock unchanged, no second purchase receipt |
| Staff sale creation, normal/search lists, own sales and detail | Accounting costs absent |
| Shop commission visibility off | Commission amounts absent from staff sale responses |
| Visibility on, own sale | Historical total/item commission 40 visible, unitCost still absent |
| Visibility on, another seller's sale with view_all_sales | Record accessible, that seller's commission hidden |
| Owner views staff sale | Cost 37 and commission 40 retained |
| Remove view_all_sales, pass owner's staffId filter | Only the caller's sales returned; another seller's detail 403; stats remain scoped to the caller |
| Staff quotation conversion, void and cash refund | Successful actions return no accounting costs |
| Permitted staff purchase cancellation | No purchase costs in response without price permission |
| Seed legacy unfiltered sale cache and replay | Costs/hidden commissions omitted; sale count unchanged |
| Reuse that key on another action/path | 409 IDEMPOTENCY_KEY_REUSED |
| Completed cached response from another shop | 403 |
| Corrupt cached JSON | 503; no new sale |
| Legacy replies on mixed-case/trailing-slash sale and conversion URLs | Still filtered |
| Sale whose seller reference no longer resolves | Restricted staff get 403 rather than a server error |
| Staff requests owner financial sales/books reports | 403 |
| Receipt token from sale detail used on public validation route | 200; sale total retained, no cost fields |

The mixed-case/trailing-slash checks were repeated through actual HTTP after restarting with the final route matching. Changed JavaScript passed syntax/whitespace checks. Web TypeScript and production build passed (74 routes). Existing test suites were not run.

## Boundaries

No database migration, cache rewrite, production deployment or removal of already-downloaded client data was performed. Hidden fields are omitted rather than reported as zero. QR/PDF generation was not modified.

Replay presentation covers the listed resources; it does not introduce a universal response policy for every endpoint or rerun every controller's mutation-permission check. In-flight legacy records without a shop field and full permission-revocation semantics across every mutation remain separate review work. Cached response shop checks operate where a shop is present in the stored resource. This review does not certify all account-transfer cases, exports, physical-client caches or whole-system security.
