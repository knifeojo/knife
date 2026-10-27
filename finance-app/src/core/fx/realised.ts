import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { formatMoney } from "@/lib/money";
import { categorize } from "../categorize";
import { aggregateUnmatchedLandings, matchPayoutLandings, type LandingLeg } from "./landings";
import { backfillMarketDates } from "./provider";
import { extractPayoutQuote } from "./quotes";
import { lagosDay } from "./rates";

const BASE = "NGN";
export const OUTLIER_TOLERANCE = 0.20;
export const MISPAIR_PREFIX = "fx-mispair:";
export const MISPAIR_PENDING = "likely mis-pair";
export const MISPAIR_KEPT = "kept conversion";
export const MISPAIR_CONFIRMED = "confirmed mis-pair";

export interface FxRebuildResult {
  realised: number;
  rejected: number;
  retagged: number;
  marketFetched: number;
  marketFailed: number;
}

export interface FxMispair {
  key: string;
  debitId: string;
  creditId: string;
  date: string;
  sent: string;
  received: string;
  impliedRate: number;
  referenceRate?: number;
  examples: string[];
  totalMinor: bigint;
}

interface FxLeg {
  id: string;
  type: string;
  amountMinor: bigint;
  currency: string;
  transactionDate: Date;
  description: string;
  counterparty: string | null;
  classificationSource: string;
  transferPairId: string | null;
  fxQuoteCurrency: string | null;
  fxQuoteMinor: bigint | null;
}

interface ImpliedPair {
  debitId: string;
  creditId: string;
  foreignId: string;
  foreign: FxLeg;
  naira: FxLeg;
  date: string;
  rate: number;
  foreignMinor: bigint;
  nairaMinor: bigint;
  quoted?: boolean;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function offBy(rate: number, ref: number): number {
  return Math.abs(rate - ref) / ref;
}

export function isOutlierRate(rate: number, reference: number | undefined): boolean {
  if (reference === undefined || !Number.isFinite(reference) || reference <= 0) return false;
  if (!Number.isFinite(rate) || rate <= 0) return true;
  return offBy(rate, reference) > OUTLIER_TOLERANCE;
}

/**
 * A USD-labeled implied rate that is far from USD but close to CAD (or ~75% of the USD
 * reference, the usual CAD/USD band) is a CAD wallet leg stored as USD.
 */
export function looksLikeCadNotUsd(rate: number, usdReference?: number, cadReference?: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (cadReference && cadReference > 0 && offBy(rate, cadReference) <= OUTLIER_TOLERANCE) {
    return !usdReference || offBy(rate, usdReference) > OUTLIER_TOLERANCE;
  }
  if (usdReference && usdReference > 0 && offBy(rate, usdReference) > OUTLIER_TOLERANCE) {
    const ratio = rate / usdReference;
    return ratio >= 0.65 && ratio <= 0.85;
  }
  return false;
}

export function mispairKey(a: string, b: string): string {
  return a < b ? `${MISPAIR_PREFIX}${a}:${b}` : `${MISPAIR_PREFIX}${b}:${a}`;
}

export function parseMispairKey(key: string): { a: string; b: string } | null {
  if (!key.startsWith(MISPAIR_PREFIX)) return null;
  const rest = key.slice(MISPAIR_PREFIX.length);
  const cut = rest.indexOf(":");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { a: rest.slice(0, cut), b: rest.slice(cut + 1) };
}

function marketOn(rows: { date: string; base: string; quote: string; rate: number }[], date: string, base: string): number | undefined {
  const hits = rows.filter((r) => r.base === base && r.quote === BASE && r.date <= date).sort((a, b) => (a.date < b.date ? 1 : -1));
  return hits[0]?.rate;
}

function asPair(a: FxLeg, b: FxLeg): ImpliedPair | undefined {
  if (a.amountMinor <= 0n || b.amountMinor <= 0n) return undefined;
  const foreign = a.currency !== BASE ? a : b.currency !== BASE ? b : undefined;
  const naira = a.currency === BASE ? a : b.currency === BASE ? b : undefined;
  if (!foreign || !naira || foreign.currency === naira.currency) return undefined;
  const rate = Number(naira.amountMinor) / Number(foreign.amountMinor);
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  const debit = a.type === "DEBIT" ? a : b.type === "DEBIT" ? b : a;
  const credit = a.type === "CREDIT" ? a : b.type === "CREDIT" ? b : b;
  return {
    debitId: debit.id,
    creditId: credit.id,
    foreignId: foreign.id,
    foreign,
    naira,
    date: lagosDay(naira.transactionDate),
    rate,
    foreignMinor: foreign.amountMinor,
    nairaMinor: naira.amountMinor,
  };
}

async function loadFxLegs(userId: string): Promise<FxLeg[]> {
  return db.transaction.findMany({
    where: { userId },
    select: {
      id: true, type: true, amountMinor: true, currency: true, transactionDate: true,
      description: true, counterparty: true, classificationSource: true, transferPairId: true,
      fxQuoteCurrency: true, fxQuoteMinor: true,
    },
  });
}

function impliedFromLinks(legs: FxLeg[]): ImpliedPair[] {
  const byId = new Map(legs.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const out: ImpliedPair[] = [];
  for (const leg of legs) {
    if (!leg.transferPairId || seen.has(leg.id)) continue;
    const partner = byId.get(leg.transferPairId);
    if (!partner || partner.transferPairId !== leg.id) continue;
    seen.add(leg.id);
    seen.add(partner.id);
    const pair = asPair(leg, partner);
    if (pair) out.push(pair);
  }
  return out;
}

function impliedFromQuotes(legs: FxLeg[], skipIds: Set<string>): ImpliedPair[] {
  const out: ImpliedPair[] = [];
  for (const tx of legs) {
    if (skipIds.has(tx.id)) continue;
    if (!tx.fxQuoteMinor || tx.fxQuoteMinor <= 0n || tx.amountMinor <= 0n) continue;
    if (tx.fxQuoteCurrency !== BASE || tx.currency === BASE) continue;
    if (tx.transferPairId && skipIds.has(tx.transferPairId)) continue;
    const rate = Number(tx.fxQuoteMinor) / Number(tx.amountMinor);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    out.push({
      debitId: tx.id,
      creditId: tx.id,
      foreignId: tx.id,
      foreign: tx,
      naira: { ...tx, currency: BASE, amountMinor: tx.fxQuoteMinor },
      date: lagosDay(tx.transactionDate),
      rate,
      foreignMinor: tx.amountMinor,
      nairaMinor: tx.fxQuoteMinor,
      quoted: true,
    });
  }
  return out;
}

async function persistExtractedQuotes(legs: FxLeg[]): Promise<void> {
  for (const tx of legs) {
    if (tx.type !== "DEBIT" || tx.currency === BASE || tx.amountMinor <= 0n) continue;
    if (tx.fxQuoteMinor && tx.fxQuoteMinor > 0n) continue;
    const q = extractPayoutQuote(tx.description, tx.amountMinor);
    if (!q) continue;
    await db.transaction.update({
      where: { id: tx.id },
      data: { fxQuoteCurrency: BASE, fxQuoteMinor: q.ngnMinor },
    });
    tx.fxQuoteCurrency = BASE;
    tx.fxQuoteMinor = q.ngnMinor;
  }
}

function asLanding(leg: FxLeg): LandingLeg {
  return {
    id: leg.id,
    type: leg.type,
    amountMinor: leg.amountMinor,
    currency: leg.currency,
    transactionDate: leg.transactionDate,
    description: leg.description,
    counterparty: leg.counterparty,
    transferPairId: leg.transferPairId,
  };
}

function pairFromLanding(
  match: { debit: LandingLeg; credit: LandingLeg; rate: number; date: string; foreignMinor: bigint; nairaMinor: bigint },
  byId: Map<string, FxLeg>,
  quoted = false,
): ImpliedPair | undefined {
  const debit = byId.get(match.debit.id);
  const credit = byId.get(match.credit.id);
  if (!debit || !credit) return undefined;
  const pair = asPair(debit, credit);
  if (!pair) return undefined;
  return { ...pair, date: match.date, rate: match.rate, foreignMinor: match.foreignMinor, nairaMinor: match.nairaMinor, quoted };
}

function impliedFromLandings(
  legs: FxLeg[],
  owners: string[],
  skipIds: Set<string>,
  referenceForDate: (date: string, currency: string) => number | undefined,
): ImpliedPair[] {
  const byId = new Map(legs.map((l) => [l.id, l]));
  const free = legs.filter((l) => !skipIds.has(l.id) && !l.transferPairId).map(asLanding);
  const matched = matchPayoutLandings(free, owners, referenceForDate);
  const pairs: ImpliedPair[] = [];
  const used = new Set<string>();
  for (const m of matched) {
    const pair = pairFromLanding(m, byId);
    if (!pair) continue;
    pairs.push(pair);
    used.add(m.debit.id);
    used.add(m.credit.id);
  }
  const leftover = free.filter((l) => !used.has(l.id));
  for (const m of aggregateUnmatchedLandings(leftover, owners, [], referenceForDate)) {
    const pair = pairFromLanding(m, byId, true);
    if (pair) pairs.push(pair);
  }
  return pairs;
}

async function loadOwners(userId: string): Promise<string[]> {
  const [accounts, user] = await Promise.all([
    db.account.findMany({ where: { userId, holderName: { not: null } }, select: { holderName: true } }),
    db.user.findUnique({ where: { id: userId }, select: { name: true } }),
  ]);
  return [...new Set([...accounts.map((a) => a.holderName!), ...(user?.name ? [user.name] : [])])];
}

export async function isBlockedMispair(userId: string, a: string, b: string): Promise<boolean> {
  const row = await db.merchantAlias.findFirst({
    where: { userId, pattern: mispairKey(a, b), subcategory: { in: [MISPAIR_PENDING, MISPAIR_CONFIRMED] } },
    select: { id: true },
  });
  return !!row;
}

async function rememberMispair(userId: string, pair: ImpliedPair, reference?: number): Promise<void> {
  const pattern = mispairKey(pair.debitId, pair.creditId);
  const existing = await db.merchantAlias.findFirst({ where: { userId, pattern }, select: { subcategory: true } });
  if (existing?.subcategory === MISPAIR_KEPT || existing?.subcategory === MISPAIR_CONFIRMED) return;
  const label = `${pair.foreign.currency}→NGN ${pair.rate.toFixed(2)} vs ${reference?.toFixed(2) ?? "typical"}`;
  await db.merchantAlias.upsert({
    where: { userId_pattern: { userId, pattern } },
    update: { subcategory: MISPAIR_PENDING, canonicalName: label.slice(0, 80) },
    create: { userId, pattern, canonicalName: label.slice(0, 80), category: null, subcategory: MISPAIR_PENDING },
  });
}

async function unpairOutlier(userId: string, debitId: string, creditId: string): Promise<void> {
  const legs = await db.transaction.findMany({ where: { userId, id: { in: [debitId, creditId] } } });
  for (const leg of legs) {
    if (leg.classificationSource === "pair") {
      const c = categorize({ description: leg.description, type: leg.type as "DEBIT" | "CREDIT" });
      await db.transaction.update({
        where: { id: leg.id },
        data: {
          transferPairId: null,
          category: c.category,
          subcategory: c.subcategory ?? null,
          classificationSource: c.source,
          classificationConfidence: c.confidence,
        },
      });
    } else {
      await db.transaction.update({ where: { id: leg.id }, data: { transferPairId: null } });
    }
  }
}

async function retagCurrency(id: string, currency: string): Promise<void> {
  await db.transaction.update({ where: { id }, data: { currency } });
}

export async function listPendingMispairs(userId: string): Promise<FxMispair[]> {
  const aliases = await db.merchantAlias.findMany({
    where: { userId, pattern: { startsWith: MISPAIR_PREFIX }, subcategory: MISPAIR_PENDING },
  });
  const out: FxMispair[] = [];
  for (const alias of aliases) {
    const ids = parseMispairKey(alias.pattern);
    if (!ids) continue;
    const legs = await db.transaction.findMany({
      where: { userId, id: { in: [ids.a, ids.b] } },
      select: { id: true, type: true, amountMinor: true, currency: true, transactionDate: true, description: true },
    });
    if (legs.length < 1) continue;
    const debit = legs.find((l) => l.type === "DEBIT") ?? legs[0];
    const credit = legs.find((l) => l.type === "CREDIT") ?? legs[legs.length - 1];
    const foreign = debit.currency !== BASE ? debit : credit.currency !== BASE ? credit : debit;
    const naira = debit.currency === BASE ? debit : credit.currency === BASE ? credit : credit;
    const rate = naira.amountMinor > 0n && foreign.amountMinor > 0n ? Number(naira.amountMinor) / Number(foreign.amountMinor) : 0;
    out.push({
      key: alias.pattern,
      debitId: debit.id,
      creditId: credit.id,
      date: lagosDay(naira.transactionDate),
      sent: formatMoney(foreign.amountMinor, foreign.currency),
      received: formatMoney(naira.amountMinor, naira.currency),
      impliedRate: rate,
      examples: [...new Set(legs.map((l) => l.description.replace(/\s+/g, " ").trim()))].slice(0, 4),
      totalMinor: naira.currency === BASE ? naira.amountMinor : 0n,
    });
  }
  return out;
}

export async function resolveMispair(userId: string, key: string, value: "unpair" | "keep"): Promise<number> {
  const ids = parseMispairKey(key);
  if (!ids) return 0;
  const pattern = mispairKey(ids.a, ids.b);
  if (value === "keep") {
    const legs = await db.transaction.findMany({ where: { userId, id: { in: [ids.a, ids.b] } } });
    if (legs.length === 2) {
      await db.$transaction([
        db.transaction.update({ where: { id: legs[0].id }, data: { transferPairId: legs[1].id } }),
        db.transaction.update({ where: { id: legs[1].id }, data: { transferPairId: legs[0].id } }),
      ]);
    }
    await db.merchantAlias.upsert({
      where: { userId_pattern: { userId, pattern } },
      update: { subcategory: MISPAIR_KEPT },
      create: { userId, pattern, canonicalName: pattern, category: null, subcategory: MISPAIR_KEPT },
    });
    await rebuildUserFx(userId);
    return legs.length;
  }
  await unpairOutlier(userId, ids.a, ids.b);
  await db.merchantAlias.upsert({
    where: { userId_pattern: { userId, pattern } },
    update: { subcategory: MISPAIR_CONFIRMED },
    create: { userId, pattern, canonicalName: pattern, category: null, subcategory: MISPAIR_CONFIRMED },
  });
  await rebuildUserFx(userId);
  return 2;
}

function referenceFor(
  date: string,
  base: string,
  market: { date: string; base: string; quote: string; rate: number }[],
  medians: Map<string, number>,
): number | undefined {
  return marketOn(market, date, base) ?? medians.get(base);
}

/**
 * Derives realised NGN rates from linked pairs, quoted payout lines, and Deel-style
 * same/next-day landings. Idempotent: rewrites the user's realised rows, rejects outliers,
 * retags CAD legs stored as USD. Market is only a fallback when no realised rate exists.
 */
export async function rebuildUserFx(userId: string): Promise<FxRebuildResult> {
  const foreignDays = await db.transaction.findMany({
    where: { userId, currency: { not: BASE } },
    select: { transactionDate: true },
  });
  const marketResult = await backfillMarketDates([...new Set(foreignDays.map((r) => lagosDay(r.transactionDate)))]);

  const [legs, marketRows, kept, owners] = await Promise.all([
    loadFxLegs(userId),
    db.fxRate.findMany({
      where: { quote: BASE, source: { in: ["market", "seed"] }, userId: "" },
      select: { date: true, base: true, quote: true, rate: true },
    }),
    db.merchantAlias.findMany({
      where: { userId, pattern: { startsWith: MISPAIR_PREFIX }, subcategory: MISPAIR_KEPT },
      select: { pattern: true },
    }),
    loadOwners(userId),
  ]);
  const keptKeys = new Set(kept.map((k) => k.pattern));
  await persistExtractedQuotes(legs);

  const linked = impliedFromLinks(legs);
  const taken = new Set(linked.flatMap((p) => [p.debitId, p.creditId, p.foreignId, p.naira.id]));
  const landings = impliedFromLandings(legs, owners, taken, (date, ccy) => marketOn(marketRows, date, ccy));
  for (const p of landings) {
    taken.add(p.debitId);
    taken.add(p.creditId);
    taken.add(p.foreignId);
    taken.add(p.naira.id);
  }
  const quotes = impliedFromQuotes(legs, taken);
  let pairs = [...linked, ...landings, ...quotes];
  const usdRates = pairs.filter((p) => p.foreign.currency === "USD").map((p) => p.rate);
  const usdMedian = marketOn(marketRows, "9999-12-31", "USD") ?? median(usdRates);
  const cadMedian = marketOn(marketRows, "9999-12-31", "CAD") ?? median(pairs.filter((p) => p.foreign.currency === "CAD").map((p) => p.rate));

  let retagged = 0;
  for (const p of pairs) {
    if (p.foreign.currency !== "USD") continue;
    const usdRef = marketOn(marketRows, p.date, "USD") ?? usdMedian;
    const cadRef = marketOn(marketRows, p.date, "CAD") ?? cadMedian;
    if (!looksLikeCadNotUsd(p.rate, usdRef, cadRef)) continue;
    await retagCurrency(p.foreignId, "CAD");
    p.foreign = { ...p.foreign, currency: "CAD" };
    retagged++;
  }

  const candidates = pairs;

  const byCurrency = new Map<string, number[]>();
  for (const p of candidates) {
    const list = byCurrency.get(p.foreign.currency) ?? [];
    list.push(p.rate);
    byCurrency.set(p.foreign.currency, list);
  }
  const medians = new Map<string, number>();
  for (const [ccy, rates] of byCurrency) {
    const m = median(rates);
    if (m !== undefined) medians.set(ccy, m);
  }

  const accepted: ImpliedPair[] = [];
  let rejected = 0;
  for (const p of candidates) {
    const reference = referenceFor(p.date, p.foreign.currency, marketRows, medians);
    const keptPair = keptKeys.has(mispairKey(p.debitId, p.creditId));
    if (!keptPair && isOutlierRate(p.rate, reference)) {
      rejected++;
      if (!p.quoted) {
        const debit = legs.find((l) => l.id === p.debitId);
        if (debit?.transferPairId === p.creditId) {
          await rememberMispair(userId, p, reference);
          await unpairOutlier(userId, p.debitId, p.creditId);
        }
      }
      continue;
    }
    accepted.push(p);
  }

  const buckets = new Map<string, { date: string; base: string; foreignMinor: bigint; nairaMinor: bigint }>();
  for (const p of accepted) {
    const key = `${p.date}|${p.foreign.currency}`;
    const cur = buckets.get(key) ?? { date: p.date, base: p.foreign.currency, foreignMinor: 0n, nairaMinor: 0n };
    cur.foreignMinor += p.foreignMinor;
    cur.nairaMinor += p.nairaMinor;
    buckets.set(key, cur);
  }

  const nextKeys = new Set<string>();
  for (const b of buckets.values()) {
    if (b.foreignMinor <= 0n) continue;
    const rate = Number(b.nairaMinor) / Number(b.foreignMinor);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    nextKeys.add(`${b.date}|${b.base}`);
    await db.fxRate.upsert({
      where: { userId_date_base_quote_source: { userId, date: b.date, base: b.base, quote: BASE, source: "realised" } },
      create: { userId, date: b.date, base: b.base, quote: BASE, rate, source: "realised" },
      update: { rate },
    });
  }

  const stale = await db.fxRate.findMany({
    where: { userId, source: "realised" },
    select: { id: true, date: true, base: true },
  });
  const staleIds = stale.filter((r) => !nextKeys.has(`${r.date}|${r.base}`)).map((r) => r.id);
  if (staleIds.length) await db.fxRate.deleteMany({ where: { id: { in: staleIds } } });

  if (retagged || rejected || nextKeys.size) {
    log.info("fx.rebuilt", { userId, realised: nextKeys.size, rejected, retagged, ...marketResult });
  }
  return {
    realised: nextKeys.size,
    rejected,
    retagged,
    marketFetched: marketResult.fetched,
    marketFailed: marketResult.failed,
  };
}

export async function rebuildAllUsersFx(): Promise<FxRebuildResult> {
  const users = await db.user.findMany({ select: { id: true } });
  const total: FxRebuildResult = { realised: 0, rejected: 0, retagged: 0, marketFetched: 0, marketFailed: 0 };
  for (const u of users) {
    const r = await rebuildUserFx(u.id);
    total.realised += r.realised;
    total.rejected += r.rejected;
    total.retagged += r.retagged;
    total.marketFetched += r.marketFetched;
    total.marketFailed += r.marketFailed;
  }
  return total;
}

/** Rebuilds realised rates for the user. Pair ids are ignored: every existing link is scanned. */
export async function storeRealisedRates(userId: string, _pairIds?: { debitId: string; creditId: string }[]): Promise<number> {
  return (await rebuildUserFx(userId)).realised;
}

/** A source-quoted NGN proceeds (Deel withdrawal) becomes a realised rate before the bank credit arrives. */
export async function storeQuotedRate(
  userId: string,
  tx: { amountMinor: bigint; currency: string; transactionDate: Date; fxQuoteCurrency?: string | null; fxQuoteMinor?: bigint | null },
): Promise<void> {
  if (!tx.fxQuoteMinor || tx.fxQuoteMinor <= 0n || tx.amountMinor <= 0n) return;
  if (tx.fxQuoteCurrency !== BASE || tx.currency === BASE) return;
  const rate = Number(tx.fxQuoteMinor) / Number(tx.amountMinor);
  if (!Number.isFinite(rate) || rate <= 0) return;
  const date = lagosDay(tx.transactionDate);
  const market = await db.fxRate.findMany({
    where: { quote: BASE, base: tx.currency, source: { in: ["market", "seed"] }, userId: "" },
    select: { date: true, base: true, quote: true, rate: true },
  });
  const reference = marketOn(market, date, tx.currency);
  if (isOutlierRate(rate, reference)) return;
  await db.fxRate.upsert({
    where: { userId_date_base_quote_source: { userId, date, base: tx.currency, quote: BASE, source: "realised" } },
    create: { userId, date, base: tx.currency, quote: BASE, rate, source: "realised" },
    update: { rate },
  });
}
