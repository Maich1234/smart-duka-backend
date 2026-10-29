# Manual payment recovery QA

No automated test suite was used. Walkthroughs were interactive HTTP requests against actual Express routes and Mongoose models, with an isolated real MongoDB instance and fixture accounts. No production data or payment provider was used.

## Reproduced and fixed

The declared compound sparse unique index `{ shop: 1, idempotencyKey: 1 }` indexes a row whose shop exists even if idempotencyKey is missing. With that index explicitly installed, the first headerless zero-value subscription activation returned 201; the second returned 500 with E11000 for `{shop, idempotencyKey:null}`.

The payment endpoint now generates a UUID key for requests that do not supply one. Supplied keys retain replay behavior. Empty or over-128-character keys return 400. No index replacement or historical-record rewrite is required. Generated keys make independent headerless attempts valid; they do not deduplicate a caller's network retry. Clients must continue sending one stable key per intent for that protection.

## Observations after fix

| Manual operation | Observed result |
|---|---|
| Two headerless activations with the real unique index | 201 and 201, separate records, each with a key |
| Same supplied key submitted twice | 201 then 200 idempotent replay; same payment ID; paid-through date unchanged on replay |
| Legacy record missing a key retained, then new headerless attempt | 201, legacy record untouched |
| 129-character key | 400 |
| Other shop owner requests payment status | 404 |

The initial fixture boot imported models before connecting, so automatic index initialization did not complete. An early headerless retry appeared to work without the index. This was not accepted as proof: the declared index was explicitly installed to reproduce the fault, and the final walkthrough used a fresh database with connection established before model initialization. This is why stored records alone are insufficient verification of index-dependent behavior.

The companion web change refreshes the subscription when a confirmed-success modal is closed through X/Escape/outside click, not just Done, and removes unverified claims that a failed/timed-out payment took no money. Paystack recheck is offered for any unsuccessful attempt with a known payment ID. Those UI transitions were reviewed in source and build/type checked; they have not been exercised in a signed-in browser or on a physical phone. Provider callbacks, live charges, concurrent starts and whole-system security remain unverified.
