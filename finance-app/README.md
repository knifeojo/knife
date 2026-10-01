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
npm test               # 178 tests: parsers, statements (PDF/CSV/XLSX), transfer pairing, AI categorizer and assistant (simulated model), benchmark, dedup, pipeline, authz, Google sign-in, AI facts
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
| `src/core/statements.ts` | CSV parser, header detection, bank/currency/account detection, row normalization |
| `src/core/pdf-statement.ts` | Rebuilds statement tables from PDF text positions (via `unpdf`), handles passwords, wrapped narrations, multi-page headers |
| `src/core/statement-import.ts` | Statement upload into the ledger (xlsx via `read-excel-file`) |
| `src/core/demo.ts` | Demo data generator (goes through the real pipeline) |
| `src/app/` | Next.js 16 App Router pages, server actions, Gmail OAuth routes |
| `tests/` | Vitest suites |

Docs: [implementation plan and MVP exclusions](docs/implementation-plan.md) · [architecture](docs/architecture.md) · [security](docs/security.md) · [Gmail OAuth setup](docs/gmail-oauth.md)

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
