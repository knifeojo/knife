# Exchange rates

Ledger converts foreign-currency amounts to naira so Afford, Review, People and totals stay in one headline unit. Each row still shows its own currency. Mixed totals never add raw dollars to naira.

## Precedence

For a currency pair on a given Lagos calendar day:

1. **Realised** — the owner’s own conversion, and the primary rate for any day with USD activity. Sources, in order:
   - A wallet payout line that **quotes** the NGN amount or rate (`@ 1550 NGN`, `NGN 155,000.00`) — used even before the bank credit is paired.
   - A **Deel / payout landing**: a USD debit (`Money transfer to <owner> / Deel withdrawal`) matched to an NGN credit the same or next Lagos day whose narration names Deel, the payout partner, or the owner. Rate = NGN received / USD sent. Match is greedy by closest implied rate within ±20% of the rolling median or market; same-day near-ties use the day’s **amount-weighted aggregate** (`sum(NGN) / sum(USD)`).
   - Every linked foreign↔naira pair (`transferPairId`) and unpaired source quote (e.g. Deel CSV). Same-day pairs are also amount-weighted.
   A pair more than ~20% from that month’s median (or the daily market rate) is **rejected before pairing**, and again at rebuild: it is unpaired, flagged in Review as a likely mis-pair, and never stored as a rate. A **hard sanity band** (USD 500–3000, CAD 400–2500, GBP 700–3500 NGN per unit) applies even when the median is poisoned. Debt repayments, internal “debited from CAD wallet to fund GBP wallet” lines, and credits whose counterparty is a different named third party are never paired. Both legs are labelled **Own transfer** so unpairing a landing cannot silently recreate Income. Used for that pair and as the preferred rate within **7 days**. Market is only a fallback when no realised rate exists for that window (never a realised rate more than 30 days away). Bundled seed rates are loaded automatically when none exist.
2. **Daily market** — the free public [Currency API](https://github.com/fawazahmed0/currency-api) (no API key), cached in `FxRate` with source `market`. Official / interbank style. Ledger fetches every Lagos day that has a foreign-currency transaction. Offline it falls back to the nearest cached day.
3. **Manual (street)** — a rate the owner types in Settings. Wins over market when they prefer street rates. Never beats a realised rate for its own pair within the 7-day window.

If nothing nearer applies, Ledger uses the latest realised rate **within 30 days**. Older realised rates are not reused, so a single bad pair cannot convert months of activity. A **seed** (or any cached market rate) from more than 30 days earlier is still used so totals do not go blank, but it is labelled **approximate**. Bundled `seed.json` rows are written automatically when the store has no market or seed rates.

Detail views show `converted at ₦X per $ (realised|market|manual|approximate) on date`.

## Official vs street naira

Official (interbank / public feed) and Lagos street rates differ, often by a lot. Settings → Exchange rates lets you choose:

- **Official / market feed** — the cached daily public rate.
- **Street (my manual override)** — the naira-per-unit figure you enter.

Realised rates from your own wallet-to-bank payouts always win for that pair, whichever you prefer for the rest.

## Schema and setup

```bash
npx prisma generate
npx prisma db push
```

`FxRate` is `(date, base, quote, rate, source, userId)`. Shared market/seed rows use an empty `userId`. Realised and manual rows are per user.

After a rule change, re-apply categories (Settings → Re-run categorization, or):

```bash
npm run recategorize -- --email you@example.com
```

That also rebuilds FX (pairs made before the FX tables existed get rates; outliers are dropped). To rebuild rates only:

```bash
npm run fx:rebuild -- --email you@example.com
```

Omit `--email` to rebuild every user. The server also rebuilds on startup after an import. Hand labels and paired own-transfers are left as they are unless a pair’s implied rate is an outlier.

## Refreshing market rates

In Settings, **Refresh daily market rates** fetches USD-based quotes (USD, CAD, GBP, EUR, GHS, KES, XOF → NGN) and caches them locally. Needs network once; after that conversion is offline.

A small offline sample lives in `src/core/fx/seed.json`. Load it with `seedMarketRates` / `seedBundledMarketRates` if the public feed is unreachable. Using that January sample for a September amount is marked approximate.
