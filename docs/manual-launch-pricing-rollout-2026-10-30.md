# Existing-plan pricing rollout, 30 October 2026

## Root cause and intended prices

A read-only request to the live public plans endpoint returned Starter at KES 1 per staff member (up to 9), and Business at KES 2,000 for up to 20 with overflow charges. Growth and the KES 50 monthly charge were absent. The defaults had changed in source, but existing database plans were never migrated: ensureDefaultPlans only inserted into an empty collection. Changing web labels or cache keys alone cannot fix billing.

| Shop users, including owner | Monthly base | Monthly charge | Monthly total |
| --- | --- | --- | --- |
| 1 to 3 | KES 240 | KES 50 | KES 290 |
| 4 to 8 | KES 500 | KES 50 | KES 550 |
| 9 or more | KES 2,000 | KES 50 | KES 2,050 |

## Implementation and rollout

Public and authenticated plan reads await the same one-time launchPricingService revision. A transaction updates existing Starter/Business IDs, creates Growth if missing, applies the agreed user bands, monthly charges and overflow tiers, and stores plan-only before/after snapshots with a durable revision marker. IDs, existing entitlements, trial settings, subscriptions and historical payments are not replaced. New plan insertion uses default content; existing plans retain their feature lists and descriptive content except obsolete user-limit highlights.

The durable marker prevents later cold starts from overwriting subsequent admin price edits. Concurrent workers either observe the same completed revision or retry/roll back. A failure does not serve old prices as though the rollout succeeded. Preview deployments cannot apply a missing revision, because the Vercel project currently scopes its database credential to both preview and production. The preview gate was checked before collection initialization or writes. Existing applied revisions can be read normally.

Merge/deploy the backend change first. Its first public or authenticated plan request in production applies the revision and returns current prices. No manual database secret extraction or separate migration command is required. The public endpoint returns no-store; the companion web update changes the pricing request version and refreshes active public pricing every minute and on window focus.

Annual offer copy no longer claims an exact two months free or extra benefits that do not follow from the calculated price. Actual cycle totals and configured entitlements remain authoritative.

## Independent verification

Used the Vercel Sandbox workflow with an ephemeral MongoDB 7.0.24 replica set, the production Express app/models and only synthetic records. No existing test suite, live database mutation, provider payment or outgoing message was used. The sandbox had no production credentials and was stopped after verification.

- Seeded the old live plan shapes. Concurrent actual HTTP GET /public/plans and /subscriptions/plans returned all three bands and matching monthly totals 290/550/2050. Public response was no-store.
- Checked headcounts 1, 3, 4, 8, 9, 20 and 100, plus an outgrown explicitly selected Starter: correct band and monthly total.
- Existing plan IDs, custom feature list and trial length were retained. A synthetic historical subscription-payment amount remained unchanged.
- Six independently imported cold-start service instances produced one Growth row and one revision record.
- A later admin price edit survived a fresh service instance.
- Injected a failure while updating Growth: earlier Starter update rolled back, no partial revision marker remained, and retry succeeded.
- Empty collection initialization produced three plans.
- The final preview-only guard was verified separately with a missing marker and a collection initializer that would fail if reached: it rejected before initialization/writes.
- Changed JavaScript passed syntax and whitespace checks. No dependencies changed.

The standalone one-off script remains available for operators; this rollout replaces the empty-only runtime initializer. Production deployment and post-deployment live price verification are still required. No tax percentage or statutory VAT compliance is asserted by the fixed additional-charge label.

## Earlier settlement verification completed

The same isolated environment also resolved the previous local database verification limitation for the already-merged M-Pesa method-removal change. Actual HTTP requests confirmed: disabled M-Pesa blocks fresh prompts; successful payments settle a sale and quotation; two requests racing for one payment create one sale and decrement stock once; reused, insufficient, pending and unverified references reject without extra stock movement. No Safaricom request was sent. Provider initiation concurrency and late-callback reconciliation remain separate outstanding work.
