# Flat shop-user pricing and fixed charge

Approved monthly tiers count the owner plus active staff:

| Users | Base KES | Fixed monthly charge KES | Monthly total KES |
|---|---:|---:|---:|
| 1–3 | 240 | 50 | 290 |
| 4–8 | 500 | 50 | 550 |
| 9+ | 2,000 | 50 | 2,050 |

The KES 50 instruction is implemented as a fixed additional charge per shop per billed month, not a percentage VAT rate. No statutory tax-rate assumption was made. Quarterly/yearly invoices include 3/12 charges. Existing cycle discounts apply to the base price; promo/referral discounts retain their prior behavior of applying to the resulting invoice total. The rollout script normalizes quarterly/yearly discounts to the default 10%/20% and clears old explicit yearly overrides.

- Flat Starter and new Growth tier; Business has no per-user overflow charge.
- Outgrown plan slugs resolve to the covering active tier before payment creation. Mid-period staff changes use overflow bands for the correct prorated price difference; renewal uses the actual covering plan.
- Payment records snapshot the additional charge; historical payments are not rewritten.
- Free activation now accepts provider `free` in the Subscription schema. A real database walkthrough exposed that the application already wrote this provider, while the schema rejected it.
- Existing plan IDs and feature flags are preserved by the migration; only pricing fields, active state, currency and pricing copy are updated. Newly inserted Growth inherits Starter's default core features.

## Rollout

1. Deploy this backend and the companion web pricing changes.
2. With the intended database's MONGO_URI configured, run `node scripts/updateLaunchPricing.mjs` to preview.
3. Review the three resulting bands and run `node scripts/updateLaunchPricing.mjs --apply`.
4. Check public pricing and authenticated renewal/checkout in the deployed browser before taking a real payment. Existing clients may need refresh for new pricing copy.

Changing seed constants alone does not update stored plans. No live database migration was run during development. Existing successful payments and paid-through dates remain unchanged. New purchases and future seat changes use the new prices after migration.

## Manual verification performed

No existing test suite or unit-test runner was used. Production Express routes and Mongoose models were exercised interactively against a fresh, isolated real MongoDB 7.0.24 instance, with local fixture accounts and no live provider credentials. Requests were inspected and compared with stored documents.

| Walkthrough | Observed result |
|---|---|
| Public catalog | 3 flat tiers; correct bases, KES 50 charges and user ranges |
| Monthly previews for 1, 3 / 4, 8 / 9, 21, 999 users | HTTP 200; 290 / 550 / 2,050 |
| Quarterly for 3 / 8 / 9 users | 798 / 1,500 / 5,550; includes 150 charge |
| Yearly for 3 / 8 / 9 users | 2,904 / 5,400 / 19,800; includes 600 charge |
| 9 users explicitly request Starter | Resolves Business at 2,050 |
| Real 9-user renewal count | Business; 2,050, including the owner |
| 100% promo activation | Initially exposed invalid `free` provider; after schema fix HTTP 201, success, Business saved, zero payment and period end persisted |
| Payment-status read after activation | HTTP 200; success and additional-charge snapshot present |
| 50% promo at 8 users | 275 due; 275 discount |
| 3 to 4 users, half month remaining | Seat preview 130; actual POST /staff HTTP 201 accrues 130; renewal is 550 + 130 = 680 |
| 8 to 9 users, half month remaining | Seat preview 750; full-period difference 1,500 |
| Unknown promo / plan | HTTP 400 / 404 |
| Zero users / missing auth / client-supplied amount | HTTP 400 / 401 / 400 |
| No provider configuration | HTTP 503; no additional payment created |
| Migration preview | No price change in stored plan |
| Migration apply twice | Correct values, original plan IDs, exactly 3 plans, no duplicates |

Browser baseline: the current production homepage and Pricing navigation loaded successfully, showing the existing database's old Starter and Business prices. This does not verify the proposed pricing UI. The proposed web build and TypeScript check pass, but signed-in browser testing of the new UI, physical Android/iOS checks, M-Pesa/Card provider completion, concurrency and full system QA remain unverified. The native app's subscription screen was inspected and has no pricing/purchase surface; no APK was built.
