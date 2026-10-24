# Architecture

## Pipeline

```
Gmail (read-only)          Fixtures          Demo         Future: statement, Mono, SMS
      │                        │               │                    │
      ▼                        ▼               │                    │
 EmailSource.listMessageIds(query, after)      │                    │
      │  skip ids already in processed_emails  │                    │
      ▼                                        │                    │
 EmailSource.getMessage  (body in memory only) │                    │
      ▼                                        │                    │
 parseEmail → BankAlertParser registry         │                    │
      │  parsed | failed | skipped             │                    │
      ▼                                        ▼                    ▼
             CanonicalTransaction  { source, sourceTransactionId, ... }
                                   │
                                   ▼
                        ingestTransaction(userId, tx)
                          1. seen (source, sourceId)?  → duplicate
                          2. exact fingerprint?        → link, duplicate
                          3. fuzzy, other source only? → link, duplicate
                          4. categorize (user rules → global rules → defaults)
                          5. insert transaction + transaction_sources row
                          6. update account balance from balance-after
                                   │
                                   ▼
                   transactions (ledger, source of truth)
                     │               │                │
                 analytics        recurring         ask/
                 (SQL sums)       detection         intent → facts → optional LLM wording
```

## Key decisions

**Money is integer kobo in `BigInt`.** Parsers convert strings to minor units without floats. Formatting happens only at the UI edge.

**One ingestion entry point.** Every source calls `ingestTransaction()`. Adding Mono or statements means writing a provider that emits `CanonicalTransaction`, nothing else.

**Dedup is layered** (details in `src/core/dedup.ts`):
- With a bank reference, the fingerprint excludes the date, because value date and posting date differ across sources.
- Without a reference, it includes date, normalized description and balance-after, so two real ₦5,000 Uber rides on the same day stay separate.
- Fuzzy matching runs only across different sources. Inside one source it would merge genuine repeat purchases.
- Every observation is kept in `transaction_sources`, which is the basis for future reconciliation (MATCHED / EMAIL_ONLY / ...).

**Categorization is deterministic.** Order: user-learned aliases, global rules, transfer/income defaults. It only returns `category`, `subcategory`, `merchantName`, `counterparty`, `source`, `confidence`. Amount, date and reference are not inputs to it, so they cannot be changed by it. Corrections create a user-scoped `merchant_aliases` row keyed on merchant or counterparty, and re-label same-merchant rows that were not already user-set.

**The LLM is never the source of truth.** `ask/intent.ts` parses the question with rules. `ask/answer.ts` runs Prisma aggregates and produces a deterministic headline plus a facts table. If `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` are set and the user turned AI on, Claude rewords the headline from the facts JSON only, and `onlyUsesFactNumbers()` rejects any output containing a number not present in the facts, falling back to the template.

**Spending excludes "Own transfer".** Transfers to other people count as spending under "Transfers"; moves to your own savings do not. Users mark own transfers by recategorizing once; the rule then applies going forward.

**Incremental Gmail sync.** A date watermark (`after:` last sync minus 2 days) plus the `processed_emails` table. Simpler than `history.list` and immune to history expiry. `gmailHistoryId` is stored for a later switch to push notifications.

## Data model

`users`, `sessions`, `financial_connections` (one per user per provider, encrypted tokens), `accounts` (last 4 digits only), `transactions`, `transaction_sources`, `merchant_aliases`, `processed_emails` (metadata only), `sync_runs` (metrics). Categories are a fixed list in code for the MVP.

## Observability

`sync_runs` records per run: emails scanned, parsed, created, duplicates, parse failures, skipped, average parse confidence, error. The Accounts page shows the last 5. Logs are JSON lines through `src/lib/log.ts`, which redacts tokens, bodies and 10-digit account numbers.

## Deployment

- Vercel for the app. Set the env vars from the README. `APP_URL` must match the Google redirect URI.
- Managed Postgres (Neon or Supabase): change `provider` to `postgresql` in `prisma/schema.prisma`, run `prisma db push` (or adopt migrations). Note that `contains` search is case-sensitive on Postgres; add `mode: "insensitive"` there.
- First Gmail sync runs inside the OAuth callback and is capped at 1,000 messages. For heavy mailboxes move it to a background job (Inngest, Trigger.dev or Vercel Cron + queue).

## Towards the AI personal finance assistant

Built in this order, each step tested before the next.

| Step | What | Where |
|---|---|---|
| 1. Own-account transfer pairing | Debit in one account + credit in another, same amount, within 2 days, plus a clue (your name, or the other bank named in the narration). Both legs become "Own transfer" and link to each other. Runs after every import. | `src/core/transfers.ts` |
| 2. AI categorizer | A local model through Ollama by default (`qwen2.5:3b`, JSON-schema output), Claude only with `AI_PROVIDER=anthropic`. Suggests a label for rows the rules left generic or uncertain. Sees only redacted narration, payee, merchant, amount, direction and date. Answers must be in the taxonomy (`src/core/taxonomy.ts`), fit the direction, and reach confidence 0.6; they are stored as `CategorySuggestion` rows and applied only when the owner confirms in Review, which saves a MerchantAlias rule. Never touches user answers or pairs. Runs after imports (background, 40 rows) and via `npm run ai:suggest`. | `src/core/ai/categorizer.ts`, `src/core/ai/suggestions.ts` |
| 3. Financial profile | Accounts, holder, income sources and typical pay day, labelled people, regular payments, monthly averages, data date range. Shown on "About you" and given to the cloud assistant as context (never to the categorizer). | `src/core/profile.ts` |
| 4. Assistant | Manual tool loop with 9 strict tools (period summary, categories, income sources, transaction search with exact totals, period comparison, person summary, recurring, balances, profile). Tools compute and format every figure. A guard rejects answers containing figures no tool returned, asks once for a grounded answer, then flags it. Falls back to the rule-based answers without AI. | `src/core/ai/assistant.ts` |
| 5. Pattern learning | Same payee or memo in 2+ months with similar amounts becomes a "regular payment" question ranked higher. Learning from the user happens through rules (answers and confirmed AI suggestions). | `src/core/review.ts` |
| 6. Accuracy scorecard | Ground truth = the user's answers. Scores what the categorizer would have done without being told (user rules withheld; the AI never sees the user's labels). History in `eval_runs`. Plus a 40-case benchmark in CI with a no-regression floor. | `src/core/eval.ts`, `tests/benchmark.test.ts` |

All Anthropic calls enable Anthropic's server-side refusal fallback (`fallbacks: "default"`), so a safety decline is retried on a fallback model instead of failing.
