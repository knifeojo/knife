# Ledger (working name)

AI-native personal finance for Nigeria. Connects to bank transaction alerts in Gmail (read-only), turns them into a deduplicated, categorized ledger, and answers questions with numbers computed from that ledger.

**Loop proven by the MVP:** Connect → Ingest → Understand → Display → Ask.

## Run it

```bash
npm install
cp .env.example .env   # then set ENCRYPTION_KEY (command in the file)
npm run setup          # creates the SQLite database
npm run dev            # http://localhost:3000
```

```bash
npm test               # parsers, statements (PDF/CSV/XLSX), transfer pairing, AI categorizer and assistant (simulated model), benchmark, dedup, pipeline, authz, Google sign-in, mobile API, AI facts, affordability
npm run build
```

Ways to get data in:

1. **Try the demo** on the landing page. Every click gets a private sandbox with 6 months of labelled DEMO DATA.
2. **Upload bank statements (real data, no Google setup).** Sign up, then upload one or more PDF, CSV or Excel statements from the welcome screen or Accounts. Password-protected PDFs are supported (the password is used once in memory, never stored). Bank, currency and account are detected per file; overlapping statements and rows already seen from alerts are merged. Samples: `/sample-gtbank-statement.pdf` and `/sample-gtbank-statement.csv`.
3. **Import sample alerts** on Accounts: 13 synthetic GTBank emails through the real pipeline.
4. **Continue with Google + Connect Gmail** after following [docs/gmail-oauth.md](docs/gmail-oauth.md).

## What's where

| Path | What |
|---|---|
| `src/core/parsers/` | `BankAlertParser` interface, registry, `GTBankParser`, HTML to text |
| `src/core/dedup.ts` | Fingerprint + cross-source fuzzy matching |
| `src/core/categorize.ts` | Rules, merchant normalization, counterparty extraction, learning key |
| `src/core/ledger.ts` | `ingestTransaction()` (single entry point for every source) and `syncEmailSource()` |
| `src/core/providers/` | `EmailSource` (Gmail, fixtures) and the future `FinancialDataProvider` interface |
| `src/core/analytics.ts` | User-scoped aggregates, recurring detection, recategorize |
| `src/core/ask/` | Intent parser → SQL facts → optional Claude phrasing with a number guard |
| `src/core/affordability.ts` | "Can I really afford this?" Pure BigInt formula (`assessAffordability`) and the ledger reads behind it |
| `src/core/statements.ts` | CSV parser, header detection, bank/currency/account detection, row normalization |
| `src/core/pdf-statement.ts` | Rebuilds statement tables from PDF text positions (via `unpdf`), handles passwords, wrapped narrations, multi-page headers |
| `src/core/statement-import.ts` | Statement upload into the ledger (xlsx via `read-excel-file`) |
| `src/core/demo.ts` | Demo data generator (goes through the real pipeline) |
| `src/app/` | Next.js 16 App Router pages, server actions, Gmail OAuth routes |
| `src/app/api/v1/` | JSON API for the Android app (bearer tokens) |
| `tests/` | Vitest suites |
| `../ledger_mobile/` | Flutter Android client |

Docs: [implementation plan and MVP exclusions](docs/implementation-plan.md) · [architecture](docs/architecture.md) · [security](docs/security.md) · [Gmail OAuth setup](docs/gmail-oauth.md)

## Mobile API

The Android app talks to `/api/v1`. The web app is unchanged: it still signs in with the httpOnly cookie and server actions. Mobile sessions are rows in the same `sessions` table, but the phone sends `Authorization: Bearer` and the API does not read the cookie.

Money is a string of minor units (`"198361100"` is ₦1,983,611.00). Dates are ISO-8601.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/health` | no | Check a server URL. `{ ok, service: "ledger", version: 1 }` |
| POST | `/api/v1/auth/signup` | no | `{ email, password, name? }` → `{ token, expiresAt, user }` |
| POST | `/api/v1/auth/login` | no | `{ email, password }` → `{ token, expiresAt, user }` |
| POST | `/api/v1/auth/logout` | bearer | Revokes that token only |
| GET | `/api/v1/auth/session` | bearer | Current user and expiry |
| GET | `/api/v1/accounts` | bearer | Accounts, masked numbers, balances |
| GET | `/api/v1/transactions` | bearer | Paged ledger. Filters: `category`, `type`, `accountId`, `q`, `from`, `to`, `page`, `pageSize` |
| GET | `/api/v1/summary` | bearer | Month income, expenses, net, category totals, recent rows. `month=YYYY-MM` or `offset=-1` |
| POST | `/api/v1/statements` | bearer | Multipart PDF, CSV or XLSX (`file` or `files`). Optional `password` for a PDF, used once in memory |
| POST | `/api/v1/affordability` | bearer | `{ amountMinor: "250000000", description?, horizon?: "month_end" \| 1..120 (days), bufferMinor? }` → `{ verdict: "yes" \| "stretch" \| "no", headline, detail, notes, inputs, projection, monthsToSave }`. 409 until the user has transactions |

Run the server so a phone on the same tailnet can reach it:

```bash
npx next dev -H 0.0.0.0 -p 3000
```

How to build the app and point it at this machine: [../ledger_mobile/README.md](../ledger_mobile/README.md).

## Can I really afford this?

Web: **Can I afford it?** in the sidebar (`/app/afford`). Phone: the **Afford** tab. Both call the same code (`src/core/affordability.ts`) and show the same breakdown, so the user can check every input. Nothing in the ledger changes, and all maths is on integer kobo (`bigint`).

**Inputs, all from the user's ledger**

| Input | Where it comes from | Default when data is thin |
|---|---|---|
| Cash | Sum of the latest reported naira balances (statement or alert). Other currencies are listed as not counted | No balance on file: starts from ₦0 and says so. Balances are never estimated |
| Typical monthly income | `summary()` income (loan proceeds, fee refunds and own transfers already excluded) for the 3 most recent full calendar months with data | Middle of 3 months. With 1 or 2 months: the **lowest**. With no full month: ₦0 |
| Typical monthly spending | `summary()` expenses for the same months | Middle of 3. With 1 or 2: the **highest**. Only the month in progress: scaled to 30 days |
| Fixed obligations | Regular monthly payments (`recurring()`) in Housing, Family, Debt, Utilities, Subscriptions, Business. So rent, family support, FairMoney or Renmoney repayments | A payment more than 45 days past due is treated as finished |
| Other loan repayments | Debt debits in the typical month that are not a monthly stream (weekly app repayments), spread evenly over the days ahead | Highest month when fewer than 3 |
| Everyday spending | Typical spending minus fixed obligations | Never below ₦0 |
| Safety buffer | One month of fixed obligations, or the user's own figure | Never below ₦50,000 (`BUFFER_FLOOR_MINOR`) |

**Window.** To month end (default), or the next 30 or 90 days (API: 1 to 120). It starts at the balance date if that is in the past, so spending since then is estimated instead of ignored.

**Projection, day by day.** Start with cash. Take off each fixed obligation on its expected date (one that is overdue by under 45 days is due today), everyday spending and other loan repayments spread evenly, and the purchase today. Add income on the dates of regular paydays Ledger has found. A payday more than 10 days late is not assumed. If no payday has been found, one typical month of income is added for each full 30 days ahead, at the end of those 30 days. Outgoings land before income on the same day.

**Verdict** from the lowest point of that running balance:

- **Yes**: the lowest point stays at or above the buffer.
- **Stretch**: it stays at or above ₦0 but dips into the buffer.
- **No**: it goes below ₦0.

Not yes? The answer adds how many months of the usual surplus (income minus obligations minus everyday spending) would close the gap, or says there is no surplus. Notes flag every caveat: no balance, an old balance, under 3 months of history, no income, outgoings above income, a price above a month's income.

Loan repayments only count if they are categorized as Debt. A repayment into a lender account in the borrower's own name ("TO FAIRMONEY MFB - JANE DOE") is now Debt / Loan repayment, not an own transfer. Run **Re-apply categories** in Settings to fix rows imported before this change.

## Environment

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | `file:./dev.db` locally; Postgres URL in production (switch `provider` in `prisma/schema.prisma`) |
| `ENCRYPTION_KEY` | yes | 32 bytes base64. Encrypts OAuth tokens at rest |
| `APP_URL` | yes | Public origin, used for the OAuth redirect URI |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for Gmail | OAuth web client |
| `ANTHROPIC_API_KEY` | no | Enables the AI categorizer and assistant (each user must also turn AI on in Settings) |
| `GMAIL_QUERY_GTBANK` | no | Override the Gmail search for GTBank alerts |

## Status against the Definition of Done

| # | Criterion | Status |
|---|---|---|
| 1 | Public URL | Not deployed. Runs locally; deploy notes in [architecture](docs/architecture.md#deployment) |
| 2 | Create account | Done, verified in browser |
| 3 | Demo mode | Done, verified in browser |
| 4, 5 | Gmail OAuth, read-only | Built (consent screen, state check, scope check, encrypted tokens). **Not tested against Google**: needs OAuth credentials |
| 6, 7 | Finds and parses GTBank alerts | Parser passes 16 fixture tests. **Fixtures are synthetic**; validate against real alerts before claiming live |
| 8 | Transactions in dashboard | Done |
| 9 | No duplicate transactions | Done, tested (resent alert, statement, open banking) and verified in browser |
| 10 | Categories and summaries | Done |
| 11 | Disconnect Gmail | Built (revokes at Google, deletes tokens). Not tested against Google |
| 12 | No bank credentials | Enforced by design: no such fields exist |
