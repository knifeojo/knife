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
| GET | `/api/v1/transactions` | bearer | Paged ledger. Filters: `category`, `type`, `accountId`, `q`, `from`, `to`, `cadence` (`recurring` \| `one_off` \| `everyday`), `payee` (one matched name, every spelling), `page`, `pageSize`. Each row has `cadence` (`"recurring"`, `"one_off"` or `null`) and `recurringBill`; the page has `oneOffMinMinor` and `cadenceSince` |
| GET | `/api/v1/summary` | bearer | Month income, expenses, net, category totals (with `recurringMinor`, `oneOffMinor`), recent rows (with `cadence`), and `spendingSplit`: `{ recurringBillsMinor, recurringOtherMinor, oneOffMinor, everydayMinor, oneOffMinMinor, labelled, oneOffs[], everyday: { totalMinor, count, byCategory[], byPayee[] }, payees[], unlabelled: { count, totalMinor, needsReview, reviewQuestions } }`, and `recurring[]` (`{ name, label, category, kind: "fixed" \| "variable" \| "frequent", bill, averageMinor, occurrences, months, lastDate, nextExpected, aliases[] }`). `payees[]`: `{ name, label, category, totalMinor, count, recurringMinor, oneOffMinor, everydayMinor, regular, unlabelledMinor, variants[], unnamed }`. `month=YYYY-MM` or `offset=-1` |
| GET | `/api/v1/review` | bearer | The web Review questions: `{ questions[]: { kind, key, title, prompt, totalMinor, count, examples[] (full narrations), options[], currentCategory, hint, narrationHints[]: { words, category, subcategory }, allowsOther }, totalMinor, categories }` |
| POST | `/api/v1/review` | bearer | `{ kind, key, value, otherText?, otherCategory? }` → `{ updated }`. `value: "unknown"` is "Can't remember"; a narration hint is answered as `value: "other"` with its words |
| POST | `/api/v1/categorize` | bearer | Re-run categorization, the same as the web Settings button → `{ checked, changed, message }`. Hand labels and Review answers are kept |
| POST | `/api/v1/statements` | bearer | Multipart PDF, CSV or XLSX (`file` or `files`). Optional `password` for a PDF, used once in memory |
| POST | `/api/v1/affordability` | bearer | `{ amountMinor: "250000000", description?, horizon?: "month_end" \| 1..120 (days), bufferMinor? }` → `{ verdict: "yes" \| "stretch" \| "no", headline, detail, notes, inputs, projection, monthsToSave, advice }`. `advice[]`: `{ kind: "debt" \| "cut" \| "one_off" \| "none", text, subject, monthlyMinor, openMinor }`. `inputs.obligations[].kind` is `"recurring"`; `inputs.oneOffs[]` (`kind: "one_off"`), `oneOffsTotalMinor`, `oneOffMinMinor`, `oneOffsSince`. 409 until the user has transactions |

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

### What would help

Under the verdict, a short list of next steps. Rule-based, built only from ledger aggregates; no model is called. Stretch or no gets 2 to 5 lines in this order, a yes gets at most one tip (a loan still being repaid). The rules and the judgment calls behind them:

| Line | When | What it says, and where the numbers come from |
|---|---|---|
| **Loan** (up to 2, biggest monthly repayment first) | A lender in Debt with a repayment or a payout in the 45 days before the balance date. Lender = merchant name, else counterparty, over the last 12 months | Monthly repayment: the typical full month that had a repayment (weekly repayments add up), from the same 3 months as the typical month. **Still open** is shown only when Ledger saw the loan paid out: borrowed minus repaid since the first payout. That is a floor on the principal left (repayments include interest), so it says "at least" and "interest not counted", and "at least N more months" at the usual repayment. No payout seen, or more repaid than borrowed: it says Ledger cannot tell what is left and to check with the lender. A balance is never estimated beyond that |
| **Cut back** (up to 2) | Shopping, Food, Transport, Travel or Subscriptions averaging at least ₦20,000 a month over the typical-month months, one-offs taken out. Bills, family, health and giving are never suggested | Names the category and its main subcategory when that is half or more ("Food (mostly eating out)"). The suggested cut is the smallest whole ₦1,000 a month that keeps the buffer through the window, found by re-running the same day-by-day projection with everyday spending lower from today. If even half the category does not do that, it suggests half and says how many months of saving (usual surplus plus the cut) close the gap, and how much sooner than without it |
| **One-off** (1) | A single naira debit outside every regular stream, at least ₦50,000 or a tenth of typical monthly income, whichever is more, since the first typical-month month. Not Debt, Fees, own transfers or wallet withdrawals | The total and the biggest one, with payee and date. One-offs in bill categories (a year's rent, school fees) are listed in the breakdown but not suggested for holding off |
| **Checked** | None of the above | Says that no loan, big category or one-off stood out |

The breakdown labels monthly obligations **Recurring bills** (rent, family support, loan instalments, utilities, subscriptions) and lists **One-off spends** in their own card, with the threshold. One-offs are already in past spending; they are not counted as recurring. Debt rows whose memo only says "loan", "lend" or "borrow" are not named as a loan to clear, because the narration cannot say which way the money went.

Loan repayments only count if they are categorized as Debt. A repayment into a lender account in the borrower's own name ("TO FAIRMONEY MFB - JANE DOE") is Debt / Loan repayment, not an own transfer. A transfer to a person who only banks with Carbon is a transfer, and a savings-app deposit is an own transfer; see [Categories](#categories).

## Categories

`categorize()` in `src/core/categorize.ts` is rule-based and deterministic: the same narration always gets the same category, with no model call. The optional AI categorizer (`ANTHROPIC_API_KEY` plus the per-user toggle) only looks at rows the rules leave generic or low-confidence and is off by default; no test needs it. Synthetic GTBank, First Bank and Sterling narrations in `tests/categorization/nigerian-narrations.test.ts` and `tests/fixtures/benchmark.ts` pin the behaviour.

Spending categories: Food, Transport, Housing, Utilities, Shopping, Subscriptions, Family, **Giving** (new: church, tithe, offering, charity; it used to be a subcategory of Other), Debt, Healthcare, Travel, Business, Transfers, Fees, Other. Plus Income and Own transfer, which are left out of spending. Finer detail lives in subcategories (Food / Eating out, Family / Education, Housing / Generator & diesel, Other / Cash, Healthcare / Fitness).

**Signals, in the order they win**

1. Fee rows and fee reversals.
2. The user's own rules and hand labels. Re-apply never touches rows the user labelled or own-transfer pairs.
3. Own transfers: the account holder's name on the other side, or a savings app (PiggyVest, Cowrywise, Risevest, Bamboo, Trove, ALAT Goals, OWealth, target savings, fixed deposit) → **Own transfer / Savings**. Savings interest credits stay income.
4. Lenders (FairMoney, Renmoney, Carbon/OneFi, PalmCredit, Branch, Aella, QuickCheck, OKash, EaseMoni, Lendigo, Specta, …) → **Debt / Loan repayment**, and credits from them are loan proceeds, not income. They are never treated as banks.
5. Narration rules: merchant names (Bolt Food before Bolt rides, Chowdeck, Shoprite, DSTV, IKEDC, gyms, schools, churches), then memo words people type ("house rent", "mummy upkeep", "fuel", "school fees", "tithe", "generator").
6. Card and POS purchases: the merchant is read from the card line. A known store kind gets its category; an unknown shop is **Shopping / Card purchase** at low confidence, so it shows in Review.
7. Counterparty name hints (a name with "church", "pharmacy", "school"). Otherwise a person-to-person transfer stays **Transfers**.

The recipient's bank is cut out of the narration before rules run ("TO JOHN SMITH - CARBON", "TO JOHN SMITH/CARBON REF 0001"), so a person who banks with Carbon, Kuda or Opay is not read as a Carbon loan or an Opay purchase. A lender in that bank slot still counts as Debt when the narration says "repay", the name is the user's own, or no person is named.

**What it refuses to guess**

- Amount and date never pick a category. They decide only recurring vs one-off (below); a ₦400,000 transfer to a person is still a transfer, not rent.
- A memo that only says "loan", "lend" or "borrow" ("LOAN TO JOHN") is Debt / Loans, but Afford does not name it as a loan to clear: the narration cannot say which way the money went. A credit "LOAN FROM …" from a person is left as received money.
- A bare person transfer with no memo stays Transfers; Ledger does not guess family, rent or a gift from a name alone.
- "PalmPay" is a wallet, "PalmCredit" a lender; "savings" on its own (a savings account at a bank) is not a savings app.
- Betting (Bet9ja, SportyBet, …): stakes are Other / Betting, winnings Income / Other income.

**Recurring vs one-off, outside Afford.** The Transactions page (web and phone) has a **Pattern** filter and a chip on each row; Spending has a **Recurring vs one-off** card with per-category amounts; the phone summary shows the same split. All of it comes from `src/core/cadence.ts`, which reuses Afford's own rules: `recurring()` streams (last 6 months) and Afford's one-off test (`isOneOffSpend`, at least ₦50,000 or a tenth of typical income). Streams in Housing, Family, Debt, Utilities, Subscriptions or Business are **Recurring bills**, the ones Afford counts as obligations. Rows older than 6 months get no label.

**Everyday vs recurring vs one-off.** Every debit in the last 6 months (not an own transfer) is exactly one of:

- **Recurring**: the same person or business, matched by name, paid regularly. *Fixed*: about monthly at a similar amount (rent). *Variable*: monthly for 3+ months at amounts within 3x of each other (family support of ₦40K, ₦70K, ₦25K). *Frequent*: more than twice a month for 3+ months (a shop paid by POS, web and transfer). Afford plans only for fixed and variable streams in bill categories; frequent payees are everyday-style spending with a name.
- **One-off**: a single big spend outside every regular stream (Afford's one-off test).
- **Everyday**: everything else. Web: the **Everyday** tile on Spending opens the breakdown by category and by payee, and `/app/transactions?cadence=everyday`. Phone: the Everyday tile on Home.

**Matching names and merchants.** `src/core/payees.ts` is deterministic: it lowercases names, drops rails and wallets (Opay, PalmPay, NIP, TRF, POS, WEB), legal forms (Ltd, Nigeria, Enterprises), places (Lekki, Ikeja, Mall) and titles, then treats two names as one payee when the shorter one's words all match (order-free, a 4+ letter prefix counts) or 2 of 3 do. So "TO OPAY - GRACE NNEKA EZE", "NIP TRANSFER TO PALMPAY - EZE GRACE" and "GRACE N EZE" are one person, and "POS SHOPRITE LEKKI", "POS/WEB PMNT @ SHOPRITE IKEJA CITY MALL" and "TRF TO SHOPRITE NIGERIA LTD" are one shop. A user's own label (MerchantAlias) names the group. Recurring detection, Spending's **What you spent on** and the `payee=` filter all use it. No model is called.

**Person transfers need a purpose.** A transfer whose narration names only the recipient stays **Transfers** at the default confidence: Ledger does not guess rent, family or a gift from a name. When those unlabelled payments are 30% or more of the month's spending, Spending and phone Home show "N payments need a purpose — help Ledger label them" and link to **Review**. Review shows each sample payment's full bank narration and offers purpose words already in it ("WARDROBE", "SCHOOL", "RENT" before "TO … - NAME") as one-tap answers. Each answer labels every payment to that name. The optional AI categorizer can also help, but it stays off unless the user turns it on.

**Re-apply categories to existing data.** Rows imported before this change keep their old categories until re-applied. Web: **Settings → Re-apply categories**. CLI: `npm run recategorize -- --email you@example.com`. It also moves old Other / Giving, Tithe, Offering and Charity labels (including hand-made ones and merchant aliases) to the Giving category. Hand-labelled rows otherwise keep their label.

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
