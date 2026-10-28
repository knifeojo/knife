import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { inSanityBand, isUnusableRate } from "./guard";
import bundledSeed from "./seed.json";

const BASE = "NGN";

export const REALISED_WINDOW_DAYS = 7;
/** A cached seed/market rate older than this is still used, but labelled approximate. */
export const APPROXIMATE_AFTER_DAYS = 30;
export type FxSourceKind = "realised" | "market" | "manual" | "approximate";
export type FxNgnPreference = "official" | "street";

export interface RateRow {
  date: string;
  base: string;
  quote: string;
  rate: number;
  source: string;
}

export interface Conversion {
  nairaMinor: bigint;
  /** NGN per 1 major unit of the foreign currency. */
  rate: number;
  rateDate: string;
  source: FxSourceKind;
}

export interface FxContext {
  userId: string;
  preferManual: boolean;
  realised: RateRow[];
  market: RateRow[];
  manual: RateRow[];
}

export function lagosDay(d: Date): string {
  return new Date(d.getTime() + 3600_000).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400_000;
}

function nearestOnOrBefore(rows: RateRow[], date: string, base: string, quote: string): RateRow | undefined {
  const hits = rows.filter((r) => r.base === base && r.quote === quote && r.date <= date);
  hits.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  return hits[0];
}

function nearestWithin(rows: RateRow[], date: string, base: string, quote: string, days: number): RateRow | undefined {
  const hits = rows
    .filter((r) => r.base === base && r.quote === quote && daysBetween(r.date, date) <= days)
    .sort((x, y) => {
      const dx = daysBetween(x.date, date) - daysBetween(y.date, date);
      if (dx) return dx;
      // Same distance: prefer the earlier (or same-day) realised rate.
      return x.date < y.date ? -1 : x.date > y.date ? 1 : 0;
    });
  return hits[0];
}

function latest(rows: RateRow[], base: string, quote: string): RateRow | undefined {
  const hits = rows.filter((r) => r.base === base && r.quote === quote).sort((x, y) => (x.date < y.date ? 1 : -1));
  return hits[0];
}

function asKind(source: string, rateDate: string, txDate: string): FxSourceKind {
  if (source === "realised") return "realised";
  if (source === "manual") return "manual";
  if (source === "approximate") return "approximate";
  if (daysBetween(rateDate, txDate) > APPROXIMATE_AFTER_DAYS) return "approximate";
  return "market";
}

export async function loadFxContext(userId: string): Promise<FxContext> {
  const [user, initial] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { fxNgnPreference: true } }),
    db.fxRate.findMany({
      where: { OR: [{ userId }, { userId: "" }] },
      select: { date: true, base: true, quote: true, rate: true, source: true, userId: true },
    }),
  ]);
  let rows = initial;
  // A single fetched market day must not block the bundled history. Seed when no seed rows exist.
  if (!rows.some((r) => r.source === "seed")) {
    for (const r of bundledSeed) {
      if (!Number.isFinite(r.rate) || r.rate <= 0) continue;
      await db.fxRate.upsert({
        where: { userId_date_base_quote_source: { userId: "", date: r.date, base: r.base, quote: r.quote, source: "seed" } },
        create: { ...r, source: "seed", userId: "" },
        update: { rate: r.rate },
      });
    }
    rows = await db.fxRate.findMany({
      where: { OR: [{ userId }, { userId: "" }] },
      select: { date: true, base: true, quote: true, rate: true, source: true, userId: true },
    });
  }
  const preferManual = user?.fxNgnPreference === "street";
  return {
    userId,
    preferManual,
    realised: rows.filter((r) => r.source === "realised" && r.userId === userId),
    market: rows.filter((r) => r.source === "market" || r.source === "seed"),
    manual: rows.filter((r) => r.source === "manual" && r.userId === userId),
  };
}

function liveMarket(ctx: FxContext, date: string, base: string, quote: string): RateRow | undefined {
  return nearestOnOrBefore(ctx.market.filter((r) => r.source === "market"), date, base, quote);
}

/** A stored realised rate that fails the outlier guard vs market/seed must not convert anything. */
function realisedUsable(ctx: FxContext, row: RateRow, date: string, base: string, quote: string): boolean {
  const mkt = liveMarket(ctx, date, base, quote);
  const seed = nearestOnOrBefore(ctx.market, date, base, quote);
  const ref = mkt ?? seed;
  if (!ref) return inSanityBand(row.rate, base);
  return !isUnusableRate(row.rate, base, ref.rate, mkt ? "market" : "median");
}

function pickPair(ctx: FxContext, date: string, base: string, quote: string): RateRow | undefined {
  const realisedNear = nearestWithin(ctx.realised, date, base, quote, REALISED_WINDOW_DAYS);
  if (realisedNear && realisedUsable(ctx, realisedNear, date, base, quote)) return realisedNear;
  const market = nearestOnOrBefore(ctx.market, date, base, quote);
  const manual = latest(ctx.manual, base, quote);
  const oldRealised = latest(ctx.realised, base, quote);
  const realisedOk = oldRealised && daysBetween(oldRealised.date, date) <= APPROXIMATE_AFTER_DAYS && realisedUsable(ctx, oldRealised, date, base, quote)
    ? oldRealised
    : undefined;
  if (ctx.preferManual) return manual ?? market ?? realisedOk;
  return market ?? manual ?? realisedOk;
}

function toConversion(row: RateRow, foreignMinor: bigint, txDate: string): Conversion | null {
  if (!Number.isFinite(row.rate) || row.rate <= 0) return null;
  return {
    nairaMinor: BigInt(Math.round(Number(foreignMinor) * row.rate)),
    rate: row.rate,
    rateDate: row.date,
    source: asKind(row.source, row.date, txDate),
  };
}

/**
 * Convert a foreign amount to naira at the rate that applies on `date`.
 * Precedence: realised (within 7 days) → official market or street/manual (user preference) → the other → none.
 */
export function convertToNgn(ctx: FxContext, minor: bigint, currency: string, date: Date): Conversion | null {
  if (currency === BASE) {
    return { nairaMinor: minor, rate: 1, rateDate: lagosDay(date), source: "market" };
  }
  const day = lagosDay(date);
  const direct = pickPair(ctx, day, currency, BASE);
  if (direct) return toConversion(direct, minor, day);
  // Cross via USD when we have both legs.
  if (currency !== "USD") {
    const toUsd = pickPair(ctx, day, currency, "USD");
    const usdToNgn = pickPair(ctx, day, "USD", BASE);
    if (toUsd && usdToNgn) {
      const via: RateRow = {
        date: usdToNgn.date,
        base: currency,
        quote: BASE,
        rate: toUsd.rate * usdToNgn.rate,
        source: usdToNgn.source === "realised" || toUsd.source === "realised" ? "realised" : usdToNgn.source,
      };
      return toConversion(via, minor, day);
    }
  }
  return null;
}

export function nairaOf(ctx: FxContext, minor: bigint, currency: string, date: Date): bigint | null {
  if (currency === BASE) return minor;
  return convertToNgn(ctx, minor, currency, date)?.nairaMinor ?? null;
}

/** "converted at ₦1,550.00 per $ (realised) on 24 Sep 2026" — source may be approximate. */
export function conversionLabel(c: Conversion, currency: string): string {
  if (currency === BASE) return "";
  const per = formatMoney(BigInt(Math.round(c.rate * 100)), BASE);
  const unit = currency === "USD" ? "$" : currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "CAD" ? "CA$" : currency === "GHS" ? "₵" : `1 ${currency}`;
  const [y, m, d] = c.rateDate.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const when = `${d} ${months[(m || 1) - 1]} ${y}`;
  return `converted at ${per} per ${unit} (${c.source}) on ${when}`;
}

export async function convertAmount(userId: string, minor: bigint, currency: string, date: Date): Promise<Conversion | null> {
  return convertToNgn(await loadFxContext(userId), minor, currency, date);
}
