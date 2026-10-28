import { isSelf } from "../categorize";
import { inSanityBand, isUnusableRate, median } from "./guard";
import { isInternalWalletFund } from "./pairing-rules";
import { lagosDay } from "./rates";

const BASE = "NGN";
const PAYOUT_DEBIT = /deel withdrawal|money transfer to/i;
const LANDING_PARTNER = /\bdeel\b|pesapeer|\bpesa\b|payoneer/i;
const DEEL = /\bdeel\b/i;

export interface LandingLeg {
  id: string;
  type: string;
  amountMinor: bigint;
  currency: string;
  transactionDate: Date;
  description: string;
  counterparty?: string | null;
  category?: string;
  transferPairId?: string | null;
}

export interface LandingMatch {
  debit: LandingLeg;
  credit: LandingLeg;
  rate: number;
  date: string;
  foreignMinor: bigint;
  nairaMinor: bigint;
}

function mentionsOwner(text: string, owners: string[]): boolean {
  const hay = text.toUpperCase().replace(/[^A-Z]/g, "");
  return owners.some((o) => {
    const tokens = o.toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 3);
    return tokens.filter((t) => hay.includes(t)).length >= 2;
  });
}

function hay(leg: LandingLeg): string {
  return `${leg.description} ${leg.counterparty ?? ""}`;
}

export function mentionsDeel(leg: LandingLeg): boolean {
  return DEEL.test(hay(leg));
}

export function isPayoutDebit(leg: LandingLeg, owners: string[]): boolean {
  if (leg.type !== "DEBIT" || leg.currency === BASE || leg.amountMinor <= 0n) return false;
  if (leg.category === "Debt" || isInternalWalletFund(leg.description)) return false;
  if (PAYOUT_DEBIT.test(leg.description)) return true;
  return isSelf(leg.counterparty ?? undefined, owners) || mentionsOwner(leg.description, owners);
}

export function isLandingCredit(leg: LandingLeg, owners: string[]): boolean {
  if (leg.type !== "CREDIT" || leg.currency !== BASE || leg.amountMinor <= 0n) return false;
  if (LANDING_PARTNER.test(hay(leg))) return true;
  return isSelf(leg.counterparty ?? undefined, owners) || mentionsOwner(leg.description, owners);
}

function sameOrNextDay(a: Date, b: Date): boolean {
  const da = lagosDay(a);
  const db_ = lagosDay(b);
  return Math.abs(Date.parse(`${da}T00:00:00Z`) - Date.parse(`${db_}T00:00:00Z`)) / 86400_000 <= 1;
}


/**
 * Deel / wallet payouts landing as NGN bank credits: same or next Lagos day, credit
 * names Deel / the payout partner / the owner, implied rate within ±20% of the
 * rolling median or a supplied market rate. Greedy closest-rate matching.
 * Same-day near-ties are left unmatched so the day's weighted aggregate can be used.
 */
export function matchPayoutLandings(
  legs: LandingLeg[],
  owners: string[],
  referenceFor?: (date: string, currency: string) => number | undefined,
): LandingMatch[] {
  const debits = legs.filter((l) => isPayoutDebit(l, owners));
  const credits = legs.filter((l) => isLandingCredit(l, owners));
  const raw: (LandingMatch & { gap: number; score: number })[] = [];
  for (const d of debits) {
    for (const c of credits) {
      if (d.id === c.id) continue;
      if (!sameOrNextDay(d.transactionDate, c.transactionDate)) continue;
      const rate = Number(c.amountMinor) / Number(d.amountMinor);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      const date = lagosDay(c.transactionDate);
      raw.push({
        debit: d,
        credit: c,
        rate,
        date,
        foreignMinor: d.amountMinor,
        nairaMinor: c.amountMinor,
        gap: Math.abs(c.transactionDate.getTime() - d.transactionDate.getTime()),
        score: 0,
      });
    }
  }
  if (!raw.length) return [];

  const cluster = median(raw.map((r) => r.rate));
  for (const r of raw) {
    const ref = referenceFor?.(r.date, r.debit.currency) ?? cluster;
    r.score = ref ? Math.abs(r.rate - ref) / ref : r.gap / 86400_000;
  }
  const plausible = raw.filter((r) => {
    const ref = referenceFor?.(r.date, r.debit.currency) ?? cluster;
    return !isUnusableRate(r.rate, r.debit.currency, ref);
  });
  const pool = plausible.length ? plausible : raw.length === 1 && inSanityBand(raw[0].rate, raw[0].debit.currency) ? raw : [];
  pool.sort((a, b) => a.score - b.score || a.gap - b.gap);

  const byDebit = new Map<string, typeof pool>();
  for (const r of pool) {
    const list = byDebit.get(r.debit.id) ?? [];
    list.push(r);
    byDebit.set(r.debit.id, list);
  }
  const ambiguous = new Set<string>();
  for (const [id, list] of byDebit) {
    const ranked = [...list].sort((a, b) => a.score - b.score);
    if (ranked.length >= 2 && Math.abs(ranked[0].score - ranked[1].score) < 0.02) ambiguous.add(id);
  }

  const used = new Set<string>();
  const out: LandingMatch[] = [];
  for (const r of pool) {
    if (ambiguous.has(r.debit.id)) continue;
    if (used.has(r.debit.id) || used.has(r.credit.id)) continue;
    used.add(r.debit.id);
    used.add(r.credit.id);
    out.push({ debit: r.debit, credit: r.credit, rate: r.rate, date: r.date, foreignMinor: r.foreignMinor, nairaMinor: r.nairaMinor });
  }
  return out;
}

/**
 * Same-day leftovers that did not get a unique greedy pair: one day's
 * amount-weighted rate (sum NGN / sum foreign) when that aggregate is sane.
 */
export function aggregateUnmatchedLandings(
  legs: LandingLeg[],
  owners: string[],
  matched: LandingMatch[],
  referenceFor?: (date: string, currency: string) => number | undefined,
): LandingMatch[] {
  const used = new Set(matched.flatMap((m) => [m.debit.id, m.credit.id]));
  const debits = legs.filter((l) => !used.has(l.id) && !l.transferPairId && isPayoutDebit(l, owners));
  const credits = legs.filter((l) => !used.has(l.id) && !l.transferPairId && isLandingCredit(l, owners));

  const byDay = new Map<string, { currency: string; date: string; debits: LandingLeg[]; credits: LandingLeg[] }>();
  for (const d of debits) {
    for (const c of credits) {
      if (!sameOrNextDay(d.transactionDate, c.transactionDate)) continue;
      const date = lagosDay(c.transactionDate);
      const key = `${date}|${d.currency}`;
      const g = byDay.get(key) ?? { currency: d.currency, date, debits: [], credits: [] };
      if (!g.debits.some((x) => x.id === d.id)) g.debits.push(d);
      if (!g.credits.some((x) => x.id === c.id)) g.credits.push(c);
      byDay.set(key, g);
    }
  }

  const out: LandingMatch[] = [];
  for (const g of byDay.values()) {
    if (g.debits.length < 1 || g.credits.length < 1) continue;
    if (g.debits.length < 2 && g.credits.length < 2) continue;
    const foreignMinor = g.debits.reduce((s, d) => s + d.amountMinor, 0n);
    const nairaMinor = g.credits.reduce((s, c) => s + c.amountMinor, 0n);
    if (foreignMinor <= 0n) continue;
    const rate = Number(nairaMinor) / Number(foreignMinor);
    const ref = referenceFor?.(g.date, g.currency);
    if (!Number.isFinite(rate) || rate <= 0 || isUnusableRate(rate, g.currency, ref)) continue;
    out.push({
      debit: g.debits[0],
      credit: g.credits[0],
      rate,
      date: g.date,
      foreignMinor,
      nairaMinor,
    });
  }
  return out;
}
