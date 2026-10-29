# Staff billing concurrency: manual QA and fix

## Reproduced failure

Against actual Express routes and an isolated MongoDB 7.0.24 replica set, two concurrent POST /staff requests started from three active shop users, with half a monthly period remaining. Both returned 201 and billed KES 130. Stored results were five actual users, a snapshot count of four, and two 3-to-4 adjustments totaling KES 260. Only one boundary crossing and KES 130 were due.

## Change

Staff create, edit/activation, owner removal and scheduled staff closure use a shared transaction. An internal per-shop revision write serializes competing lifecycle changes, including shops without subscriptions. Counts are read before/after inside the transaction, and the account change, billing adjustment and snapshot commit together. Driver transaction retries re-read the latest state after a conflict. Reads use snapshot concern and commits use majority write concern.

External email, push and audit work stays outside the retryable callback. The revision field is hidden from normal shop queries. Owner closure already deletes the shop transactionally, so it conflicts with the same shop write instead of allowing a staff mutation to leave an orphan. Scheduled closure rechecks that the account is still due inside its transaction; two cron invocations cannot double-credit the same staff account. The old post-delete seat-release helper is retained only for compatibility, and production lifecycle paths no longer call it.

No new index or data migration is needed. MongoDB must support transactions (replica set or sharded deployment), as the existing transactional sales and account-closure code already require. There is intentionally no nontransactional fallback for failed billing writes.

## Manual results after correction

No existing test suite or unit-test runner was used. These are real HTTP operations and real database records, with synthetic fixture accounts, not mocked models. All money below is fixture ledger accounting; no payment provider was configured.

| Operation | Observed result |
|---|---|
| Two concurrent additions, 3 to 5 users | Both 201; actual and snapshot counts 5; one 130 adjustment |
| Seven concurrent additions, 3 to 10 | Seven 201s; both counts 10; adjustments 130 and 750, total 880 |
| Concurrent removal of the two newly added staff | Both 200; both counts 3; one -130 credit; net zero |
| Two activation requests for one inactive staff account | Both 200; one 130 adjustment; both counts 4 |
| Two deactivation requests for the same account | Both 200; one -130 credit; both counts 3 |
| Concurrent create requests using the same email | 201 and 409; one user and one charge; no count drift |
| Concurrent deletion requests for the same account | 200 and 404; only one credit |
| Two concurrent scheduled-closure jobs | One staff purged by one job, zero by the other; one -130 credit |
| Account with no scheduled closure date | Account retained; no credit or count change |
| Legacy per-user pricing, two additions | Both 201; count 5; two distinct 105 adjustments, total 210 |
| Plain name edit | 200, name updated, no billing adjustment |
| Create staff before a subscription exists | 201, no billing entry |
| Other-shop staff edit/delete | Both 404; foreign account remained active |
| Owner closure concurrent with staff creation | Create committed first (201); closure then removed shop and all its users; no user remained orphaned |
| Final code with snapshot/majority concerns, repeated two-addition case | Both 201, counts 5, one 130 adjustment |
| GET /shop after lifecycle updates | Internal staffBillingRevision not exposed |

All modified JavaScript passed syntax checks; the real application started and served these flows. This does not verify live deployment, multi-node failover, transactions racing with payment callbacks, high-volume load, real provider completion, physical devices or the entire system. No production data was changed.
