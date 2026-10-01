# Implementation Plan and MVP Boundaries

Companion to the build prompt. Two things the prompt was missing: a concrete build order and an explicit list of what the MVP does not do.

## Stack decisions (locked)

| Concern | Decision | Why |
|---|---|---|
| App | Single Next.js 16 app (App Router, TypeScript), server actions + route handlers | One deployable, no separate API service |
| DB | Prisma 6 on SQLite locally, schema kept Postgres-portable | Runs with zero setup today; swap `provider` + `DATABASE_URL` for Neon/Supabase |
| Money | Integer minor units (kobo) in `BigInt` columns | No float rounding on financial amounts |
| Auth | Email + password (bcrypt), server-side sessions (hashed token in DB, httpOnly cookie) | No third-party auth dependency; Google sign-in later |
| Gmail | OAuth authorization code flow, scope `gmail.readonly` only, tokens AES-256-GCM encrypted at rest | Minimum scope that can read alert bodies |
| Jobs | Synchronous "Sync now" + sync on login when stale | No queue infra for MVP |
| AI | Deterministic intent parser + SQL aggregates; Claude only rephrases computed facts (optional, `ANTHROPIC_API_KEY`) | LLM is never the source of truth |
| Tests | Vitest: parsers, dedup, categorization, authz, AI facts | |

## Implementation sequence

Each step ends with something runnable or testable. Do not start a step until the previous one passes.

| # | Step | Output | Done when |
|---|---|---|---|
| 1 | Scaffold + schema | Next.js app, Prisma schema, `db push` | `npm run dev` serves a page, DB file exists |
| 2 | Core types | `CanonicalTransaction`, `ParsedTransaction`, `EmailMessage`, money helpers | Types compile |
| 3 | GTBank parser | `BankAlertParser` interface, registry, `GTBankParser`, HTML to text | Fixture tests pass: debit, credit, HTML, plaintext, commas, decimals, date formats, missing fields, malformed, non-GTBank |
| 4 | Fingerprint + dedup | Exact fingerprint (SHA-256) + fuzzy matcher (amount, type, date within 1 day, ref or description similarity) | Same txn from email, statement, open banking resolves to one ledger row |
| 5 | Categorization + merchants | Rule engine, merchant alias normalization, user override learning | Category tests pass; AI can never touch amount/date/ref |
| 6 | Ingestion pipeline | `ingestEmails(userId, provider)`: fetch, parse, normalize, dedup, categorize, persist, `sync_runs` metrics | Fixture ingestion run twice creates N then 0 rows |
| 7 | Auth + sessions | Sign up, log in, log out, `requireUser()` | Protected pages redirect when logged out |
| 8 | Authz tests | Every query takes `userId` from session | User A cannot read or edit user B's rows (test) |
| 9 | Demo mode | "Try Demo" creates an isolated demo user with realistic seeded data, labelled DEMO DATA | Demo loads full dashboard in one click |
| 10 | Dashboard | Overview, Transactions (filters + search + recategorize), Spending, Income, Accounts, Insights, Settings | All pages render with demo data |
| 11 | Gmail OAuth | Consent screen, connect, callback, encrypted tokens, disconnect (revokes at Google + deletes tokens) | Works end-to-end once Google credentials are set |
| 12 | Gmail sync | Bank search definitions, incremental sync (`after:` watermark + processed message ids), metadata-only storage | Sync shows "Last synced" and "New transactions" |
| 13 | Ask (AI) | Intent parser, per-intent SQL, fact table, optional Claude phrasing | Answers match DB aggregates (test) |
| 13b | Statement upload | Multi-file PDF/CSV/XLSX, PDF passwords, bank and account auto-detect, same ledger pipeline | Re-upload creates 0 rows; alert + statement merge (tests) |
| 14 | Hardening | Redacting logger, security headers, `.env.example`, docs | `npm test`, `npm run build` green |

## MVP exclusions (explicitly out of scope)

These are deliberate. Anything below is Phase 2+ and should not be built or claimed.

**Ingestion**
- Email alert parsers for banks other than GTBank (registry is ready). Statement upload already works for any bank whose export has Date, Description and Debit/Credit or Amount columns
- Open Banking / Mono (interface only, no provider implementation)
- SMS ingestion
- Scanned (image-only) PDF statements, which would need OCR, and old binary `.xls` files. (Text PDF, CSV and XLSX statement upload, including password-protected PDFs and several files and banks at once, was pulled into the MVP as the no-Gmail path to real data.)
- Gmail push notifications (Pub/Sub watch). Sync is manual plus on-login
- Background job queue or cron workers
- Gmail `history.list` incremental sync. MVP uses a date watermark plus processed message ids, which is simpler and survives history expiry

**Product**
- Reconciliation UI (MATCHED / EMAIL_ONLY / ...). Source links are stored per transaction so this can be added later
- Budgets, goals, forecasting, net worth, investments, loans, credit cards
- Multi-currency conversion. Non-NGN alerts are stored in their own currency and excluded from NGN totals
- Free-form LLM chat. "Ask" supports the listed question families only and says so when it cannot answer
- LLM-based categorization. Rules + user corrections only; the schema has `classification_source` and `confidence` ready for an AI classifier
- Shared/household accounts, teams, roles
- Admin/observability UI. Metrics are recorded in `sync_runs` per run
- Native mobile apps (web is responsive)

**Auth and accounts**
- Password reset by email (needs a transactional email provider; flagged for Phase 2)
- MFA, email verification (Google sign-in was added: identity only, Gmail stays a separate consent)
- Account deletion self-serve (Settings shows "delete my data" for synced data only)

**Never (hard constraints, not phases)**
- Bank credentials, PIN, OTP, card details, scraping bank websites
- Moving money, initiating transfers
- Gmail send, modify, delete, compose scopes
- Storing full email bodies
- LLM-generated numbers

## Known risks

- **GTBank email format is unverified.** Fixtures are synthetic, built from the two known GTBank alert styles (GeNS table format and "your account has been debited" prose). Validate against 5 to 10 real anonymized alerts before claiming Gmail ingestion is live. The parser is field-label driven, not one regex, so new labels are a one-line change.
- **Sender domain is unverified.** The default Gmail query is configurable per bank in `src/core/sources.ts`.
- **Google OAuth verification.** `gmail.readonly` is a restricted scope. Until the app passes Google verification (including a security assessment), only up to 100 test users added in the Google Cloud console can connect.
