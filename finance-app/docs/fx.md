# Exchange rates

Ledger converts foreign-currency amounts to naira so Afford, Review, People and totals stay in one headline unit. Each row still shows its own currency. Mixed totals never add raw dollars to naira.

## Precedence

For a currency pair on a given Lagos calendar day:

1. **Realised** — the owner’s own conversion. When a foreign wallet debit to their own name is paired (`transferPairId`) with an NGN credit on GTBank or another naira account the same or next day, the rate is `NGN received / foreign sent` (fees included). Source `realised`. Used for that pair and as the preferred rate within **7 days**.
2. **Daily market** — the free public [Currency API](https://github.com/fawazahmed0/currency-api) (no API key), cached in `FxRate` with source `market`. Official / interbank style. Falls back to the nearest earlier cached day.
3. **Manual (street)** — a rate the owner types in Settings. Wins over market when they prefer street rates. Never beats a realised rate for its own pair within the 7-day window.

If nothing nearer applies, Ledger uses the latest realised rate it has (so conversions still work offline before any market seed).

Detail views show `converted at ₦X per $ (realised|market|manual) on date`.

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

Hand labels and paired own-transfers are left as they are. Destination country/currency and person-vs-airtime labels update on rows the rules still own.

## Refreshing market rates

In Settings, **Refresh daily market rates** fetches USD-based quotes (USD, CAD, GBP, EUR, GHS, KES, XOF → NGN) and caches them locally. Needs network once; after that conversion is offline.

A small offline sample lives in `src/core/fx/seed.json`. Load it with `seedMarketRates` / `seedBundledMarketRates` if the public feed is unreachable.
