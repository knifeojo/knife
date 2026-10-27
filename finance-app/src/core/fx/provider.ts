import { db } from "@/lib/db";
import { lagosDay } from "./rates";
import bundledSeed from "./seed.json";

/**
 * Daily rates without an API key: the public Currency API
 * (https://github.com/fawazahmed0/currency-api) via jsDelivr, with a Cloudflare Pages fallback.
 *
 * A day: https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@YYYY-MM-DD/v1/currencies/usd.min.json
 * Latest: https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json
 *
 * The feed is closer to official/interbank than the Lagos street rate. Naira official and street
 * prices differ; Settings lets the owner prefer this market feed or a manual (street) override.
 * Realised rates from their own wallet-to-bank conversions always win for that pair.
 */
export const FX_SOURCE_ID = "currency-api";
export const FX_SOURCE_LABEL = "Currency API (fawazahmed0, no API key)";
export const FX_CURRENCIES = ["USD", "CAD", "GBP", "EUR", "GHS", "KES", "XOF"] as const;

const CDN = (date: string, base: string) =>
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/${base.toLowerCase()}.min.json`;
const PAGES = (date: string, base: string) =>
  `https://${date === "latest" ? "latest" : date}.currency-api.pages.dev/v1/currencies/${base.toLowerCase()}.min.json`;

type Feed = { date?: string } & Record<string, Record<string, number> | string | undefined>;

async function fetchJson(url: string): Promise<Feed | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as Feed;
  } catch {
    return null;
  }
}

async function fetchBase(date: string, base: string): Promise<{ date: string; quotes: Record<string, number> } | null> {
  const body = (await fetchJson(CDN(date, base))) ?? (await fetchJson(PAGES(date, base)));
  if (!body) return null;
  const quotes = body[base.toLowerCase()];
  if (!quotes || typeof quotes !== "object") return null;
  const day = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : date === "latest" ? lagosDay(new Date()) : date;
  return { date: day, quotes: quotes as Record<string, number> };
}

function ngnPer(quotes: Record<string, number>, code: string): number | undefined {
  const ngn = quotes.ngn;
  if (code === "USD") return typeof ngn === "number" && ngn > 0 ? ngn : undefined;
  const foreign = quotes[code.toLowerCase()];
  if (typeof ngn === "number" && ngn > 0 && typeof foreign === "number" && foreign > 0) return ngn / foreign;
  return undefined;
}

export async function importMarketRates(date = "latest"): Promise<{ date: string; stored: number }> {
  const usd = await fetchBase(date, "USD");
  if (!usd) throw new Error("Could not fetch daily FX rates. Check the network, or enter a rate in Settings.");
  let stored = 0;
  for (const code of FX_CURRENCIES) {
    const rate = ngnPer(usd.quotes, code);
    if (!rate) continue;
    await db.fxRate.upsert({
      where: { userId_date_base_quote_source: { userId: "", date: usd.date, base: code, quote: "NGN", source: "market" } },
      create: { date: usd.date, base: code, quote: "NGN", rate, source: "market", userId: "" },
      update: { rate },
    });
    stored++;
  }
  return { date: usd.date, stored };
}

export async function seedBundledMarketRates(): Promise<number> {
  return seedMarketRates(bundledSeed);
}

export async function seedMarketRates(rows: { date: string; base: string; quote: string; rate: number }[]): Promise<number> {
  let stored = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.rate) || r.rate <= 0) continue;
    await db.fxRate.upsert({
      where: { userId_date_base_quote_source: { userId: "", date: r.date, base: r.base, quote: r.quote, source: "seed" } },
      create: { ...r, source: "seed", userId: "" },
      update: { rate: r.rate },
    });
    stored++;
  }
  return stored;
}

export async function setManualRate(userId: string, base: string, quote: string, rate: number, date?: string): Promise<void> {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Rate must be a positive number (naira per 1 foreign unit).");
  const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : lagosDay(new Date());
  await db.fxRate.upsert({
    where: { userId_date_base_quote_source: { userId, date: day, base, quote, source: "manual" } },
    create: { userId, date: day, base, quote, rate, source: "manual" },
    update: { rate },
  });
}

export async function clearManualRate(userId: string, base: string, quote: string): Promise<void> {
  await db.fxRate.deleteMany({ where: { userId, base, quote, source: "manual" } });
}

export async function listFxForSettings(userId: string) {
  const [user, rows] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { fxNgnPreference: true } }),
    db.fxRate.findMany({
      where: { OR: [{ userId }, { userId: "" }] },
      orderBy: [{ date: "desc" }, { base: "asc" }],
    }),
  ]);
  const latestMarket = rows.find((r) => r.source === "market" || r.source === "seed");
  return {
    preference: (user.fxNgnPreference === "street" ? "street" : "official") as "official" | "street",
    sourceLabel: FX_SOURCE_LABEL,
    latestMarketDate: latestMarket?.date ?? null,
    manual: rows.filter((r) => r.source === "manual" && r.userId === userId),
    realised: rows.filter((r) => r.source === "realised" && r.userId === userId).slice(0, 12),
    market: rows.filter((r) => (r.source === "market" || r.source === "seed") && r.quote === "NGN").slice(0, 20),
  };
}
