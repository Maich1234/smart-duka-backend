# Adversarial review, 30 October 2026

Independent checks reproduced and fixed flaws in the new feature. No existing test suite was used; no customer database, provider payment or live shop mutation was used.

| Finding | Reproduction and correction |
| --- | --- |
| Valid upload always rejected | Real multipart HTTP upload returned 400 with parts:1. Corrected boundary limit; one-file HTTP now succeeds. Extra files/fields, wrong extension and >5 MB reject. |
| ZIP safety bypass | XLSX with central entry count zero was accepted. Strict directory/local-header/CRC/size validation now rejects it, then rebuilds a canonical ZIP before SheetJS sees it. Also checked dishonest expansion, compression/path mismatch, corrupt CRC and valid ExcelJS archives. |
| Corrupt data crashes entire report | Text stock, component costs or saved sale costs threw aggregation arithmetic errors. Guard numeric inputs, arrays and price ranges; exclude unknown exposures; flag affected rows across web/mobile/PDF. Evaluated actual production pipeline through in-memory Mongo operators. |
| Bundle warnings understated costs | A bundle selling at 100 with components costing 200 had no warning because the entered parent cost was 0. Preview now uses component cost, rejects ambiguous existing component SKUs, captures dependencies and rejects changed component costs at commit. Variants/components are reviewable in the web preview. The actual commit handler rejected a changed component cost before insert using a session adapter; this does not establish Mongo isolation. |
| Identifier formatting | Templates had general cells. XLS and XLSX now format identifier cells as text through row 2001; round-trip checks confirm @ format. |
| Missing semantic price history | kg-to-g changes with unchanged numeric prices made no history entry. Unit changes now record on parent and variant rows and appear in history UI. |
| Oversized audit payload | Price review joined complete change arrays when it only displayed actor/time/source. Removed those arrays from the report join; dedicated paginated history remains available. |

Executed: real Express HTTP upload and actual JWT/owner middleware with synthetic model adapters; owner/staff gates and ignored query tenant injection; invalid catalogue/array/NaN/Infinity/saved-sale cases; archive corruption; XLS/XLSX and ExcelJS; all product types; 2,000-row import; component costs and ambiguity; actual React DOM upload, child detail, warning acknowledgement, single save and completion feedback. PDF was regenerated and visually reviewed after numeric guards; signed-summary tampering rejects. Web/admin production builds and mobile TypeScript pass. Actual PDF download functions with adapters verify one native token refresh on 401 and block web/native sharing after an account switch; physical OS sharing remains unverified.

The Mongo operator evaluator and model/native adapters do NOT establish real Mongo transaction isolation, unique-index enforcement, rollback, query plans or native-device behavior. Local Mongo still terminates with open: Operation not permitted; the earlier Vercel sandbox upload remains unapproved and was not retried. No claim of complete end-to-end database verification. Use an authorized disposable replica set for the outstanding concurrent import/edit/purchase, payment/reference, assignment and rollback scenarios before release.

Rollout finding: backend PR22 and web PR19 were merged into earlier pending branches rather than main. These fixes are added to the still-open backend PR21 and web PR18 so their complete changes can reach main together. Neither was merged/deployed by this work.


## Excel guide and system responses

Added /help/excel-product-import with template fields, example products/variants/bundles, rejection reasons and recovery steps. Linked from the importer, Help Centre/related topics, DuQana AI help results and agent training form. Guide anchors account for the sticky header. Identifiers remain text-formatted.

Import rejection responses now distinguish file type, empty file, size (413), extra files/fields, rate limits, expired preview (410), unavailable preview (404) and catalogue changes. Child validation errors identify their sheet/row. Free/unknown-cost variant warnings require review. The web UI filters rejected rows, focuses result feedback, announces real checking/saving phases and preserves the selected file for retry.

Added an owner/shop-scoped read-only import-status endpoint. Lost save responses are treated as uncertain, not as proof of rollback: keep the same preview, block starting another upload, check status or retry safely. Session storage retains only the scoped batch identity and pending flag; the server revalidates access, status and expiry. Actual React DOM checks passed for lost response after save, status confirmation without a second commit, reload recovery, row errors/filters, oversize feedback and guide links. Actual server-rendered help route/tables/anchors/navigation passed. Actual HTTP status/error responses were checked with synthetic model adapters. These adapters do not establish real database atomicity.

Further financial finding: configurable parent trackInventory:false is normal, while the sales engine always tracks variant stock. The old report incorrectly zeroed variant exposure. It now uses variant quantities independently of the parent flag; the actual aggregation pipeline scenario passes with the flag off. Imported services default to untracked stock, and composite parents default to false without suppressing variant quantities.

Production web/admin builds, web/mobile/admin TypeScript, 2,000-product/parser, archive/role/numeric scenarios and the native PDF adapter checks pass. Local Mongo still cannot start; real transaction/index races and physical-device behavior remain unverified. No production merge or live customer writes were performed.
