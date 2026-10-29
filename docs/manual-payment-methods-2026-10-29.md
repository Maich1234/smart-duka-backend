# Owner payment-method propagation review — 29 October 2026

## Findings and behavior

Staff web tills did not poll shop configuration. Mobile POS refreshed every five minutes, and web repayments used a separate cache key. Both clients automatically appended Credit when the module was enabled; the sale API exempted Credit from the configured enabled list. Those paths could preserve or resurrect a button after the owner removed it.

The owner's saved enabled list now governs all displayed sale methods, including Credit. The editor requires Save changes; removing a row is initially a draft change. Save immediately updates the local shared cache. Active online sale/repayment/quotation screens refresh every 15 seconds; focus/foreground refresh catches changes made while away. This is polling, not an instantaneous cross-device push. Unfocused/background mobile screens do not poll. Removed/disabled selected methods fall back to an available method. Explicit empty lists do not restore default buttons.

The backend rejects a new sale using a method no longer enabled, including Credit. Credit permissions, customer and ledger checks remain. Historical sale labels remain intact. Shops previously relying on the automatically appended Credit button must explicitly add/enable Credit in Payment Methods. No migration or production-data rewrite is included.

## Independent manual observations

Used the actual Express API and production Mongoose models/indexes with an isolated MongoDB replica set and synthetic owner/staff accounts. Owner PUT added Bank transfer and Credit; staff recorded a Bank sale (201). Owner removed both; new-key Bank and Credit submissions returned 400 PAYMENT_METHOD_UNAVAILABLE. The earlier Bank sale retained its label.

Mounted actual web owner Payment Methods and staff Sales pages in a DOM harness, with independent authentication and query caches connected to that API. Clicked the owner's Bank suggestion and Save, then removed it and saved. Advanced the registered 15-second refresh callbacks: the staff button disappeared. Re-added Bank, selected it at the staff till, then disabled it at the owner screen and saved. After refresh, Cash was selected and Complete Sale sent paymentMethod=cash, returning 201. The final sticky save toolbar was added after these interactions and covered by the final production build.

Exercised the actual mobile shared query hook and payment resolver with simulated native AppState/navigation focus and HTTP transport to the same API. Enabled Bank appeared after refresh; background/unfocused screens made no polling requests. Removed Bank while backgrounded; returning active refreshed immediately and removed it. Navigation focus also refreshed immediately. Disabled/missing Credit did not reappear in either client's resolver. These lifecycle signals were simulated; this is not physical Android UI certification.

Web TypeScript and production build passed. Mobile full TypeScript check passed. Mobile npm ci dry-run passed after restoring two missing optional @emnapi lockfile entries; package.json and existing package versions were unchanged. Changed backend JavaScript and all diffs passed syntax/whitespace checks. Existing test suites were not used.

## Scope and rollout

Merge/deploy the backend change before the client changes. Web needs deployment; installed mobile apps need a new Expo/EAS build/update. No merge, production deployment or native build was performed here.

No live provider payment was sent. In-flight M-Pesa reconciliation, stale offline outbox policy, every historical client version and whole-app security are not certified by this review. Existing pending-request/idempotency handling and offline persistence were not rewritten. A disconnected client cannot learn the owner's latest settings until connectivity returns.
