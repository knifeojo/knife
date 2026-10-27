import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { INCOME_CATEGORY, OWN_TRANSFER, learningKey } from "./categorize";
import { convertToNgn, loadFxContext, type Conversion, type FxContext } from "./fx/rates";

// All figures come from the ledger. Every query is scoped by the userId passed in by the
// server (derived from the session), never by anything the client sends.

export const BASE_CURRENCY = "NGN";
const LAGOS_MS = 3600_000;

export interface Period {
  from: Date;
  to: Date; // exclusive
  label: string;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Calendar month in Lagos time. offset 0 = month containing `now`, -1 = previous month. */
export function monthPeriod(now: Date, offset = 0): Period {
  const local = new Date(now.getTime() + LAGOS_MS);
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth() + offset;
  const from = new Date(Date.UTC(y, mo, 1) - LAGOS_MS);
  const to = new Date(Date.UTC(y, mo + 1, 1) - LAGOS_MS);
  const lf = new Date(from.getTime() + LAGOS_MS);
  return { from, to, label: `${MONTH_NAMES[lf.getUTCMonth()]} ${lf.getUTCFullYear()}` };
}

export function specificMonth(year: number, monthIndex: number): Period {
  return {
    from: new Date(Date.UTC(year, monthIndex, 1) - LAGOS_MS),
    to: new Date(Date.UTC(year, monthIndex + 1, 1) - LAGOS_MS),
    label: `${MONTH_NAMES[monthIndex]} ${year}`,
  };
}

/** Inclusive span of `months` Lagos calendar months ending in the month that contains `now`. */
export function lastNMonthsPeriod(now: Date, months: number): Period {
  const start = monthPeriod(now, -(months - 1));
  const end = monthPeriod(now, 0);
  return { from: start.from, to: end.to, label: months === 3 ? "Last 3 months" : `Last ${months} months` };
}

export function ytdPeriod(now: Date): Period {
  const local = new Date(now.getTime() + LAGOS_MS);
  const y = local.getUTCFullYear();
  return { from: new Date(Date.UTC(y, 0, 1) - LAGOS_MS), to: monthPeriod(now, 0).to, label: `Year to date ${y}` };
}

export function calendarYearPeriod(year: number): Period {
  return { from: new Date(Date.UTC(year, 0, 1) - LAGOS_MS), to: new Date(Date.UTC(year + 1, 0, 1) - LAGOS_MS), label: String(year) };
}

export async function allTimePeriod(userId: string, now = new Date()): Promise<Period> {
  const first = await db.transaction.findFirst({ where: { userId }, orderBy: { transactionDate: "asc" }, select: { transactionDate: true } });
  const end = monthPeriod(now, 0);
  if (!first) return { ...end, label: "All time" };
  return { from: first.transactionDate, to: end.to, label: "All time" };
}

/** Each Lagos calendar month that overlaps `p` (to is exclusive). */
export function monthsInPeriod(p: Period): Period[] {
  const start = new Date(p.from.getTime() + LAGOS_MS);
  const end = new Date(p.to.getTime() + LAGOS_MS);
  const out: Period[] = [];
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  const endY = end.getUTCFullYear();
  const endM = end.getUTCMonth();
  while (y < endY || (y === endY && m < endM)) {
    out.push(specificMonth(y, m));
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return out;
}

export async function availableYears(userId: string): Promise<number[]> {
  const [first, last] = await Promise.all([
    db.transaction.findFirst({ where: { userId }, orderBy: { transactionDate: "asc" }, select: { transactionDate: true } }),
    db.transaction.findFirst({ where: { userId }, orderBy: { transactionDate: "desc" }, select: { transactionDate: true } }),
  ]);
  if (!first || !last) return [new Date(Date.now() + LAGOS_MS).getUTCFullYear()];
  const a = new Date(first.transactionDate.getTime() + LAGOS_MS).getUTCFullYear();
  const b = new Date(last.transactionDate.getTime() + LAGOS_MS).getUTCFullYear();
  const years: number[] = [];
  for (let y = b; y >= a; y--) years.push(y);
  return years;
}

/** (income − expenses) / income, or null when there is no income. */
export function savingsRate(income: bigint, expenses: bigint): number | null {
  if (income <= 0n) return null;
  return Number(income - expenses) / Number(income);
}

const range = (p: Period) => ({ gte: p.from, lt: p.to });
const notOwn = { not: OWN_TRANSFER };

/**
 * Rows that count toward income and spending: not an own transfer, and not one leg of a linked
 * movement between the user's accounts (that money is counted once, where it was earned or spent).
 */
const countable = { category: notOwn, transferPairId: null };

export interface FxRate { currency: string; rate: number; conversions: number; source?: string }

/**
 * Exchange rates learned from the user's own conversions: naira per foreign unit, median.
 * Sources, in order: a linked pair (CAD/USD sent, naira received the same day), and a rate the
 * source itself quoted (a Deel withdrawal that states the NGN proceeds). A quoted rate is skipped
 * once that row is paired, so the bank credit is not counted twice. No outside rate feed.
 */
export async function fxRates(userId: string): Promise<Map<string, FxRate>> {
  const legs = await db.transaction.findMany({
    where: { userId, transferPairId: { not: null }, currency: { not: BASE_CURRENCY } },
    select: { amountMinor: true, currency: true, transferPairId: true },
  });
  const partnerIds = legs.map((l) => l.transferPairId!);
  const partners = new Map(
    partnerIds.length
      ? (await db.transaction.findMany({ where: { id: { in: partnerIds }, currency: BASE_CURRENCY }, select: { id: true, amountMinor: true } }))
          .map((p) => [p.id, p.amountMinor] as const)
      : [],
  );
  const byCur = new Map<string, number[]>();
  const add = (currency: string, rate: number) => {
    if (!Number.isFinite(rate) || rate <= 0) return;
    byCur.set(currency, [...(byCur.get(currency) ?? []), rate]);
  };
  for (const l of legs) {
    const ngn = partners.get(l.transferPairId!);
    if (!ngn || l.amountMinor === 0n) continue;
    add(l.currency, Number(ngn) / Number(l.amountMinor));
  }
  const quotes = await db.transaction.findMany({
    where: { userId, currency: { not: BASE_CURRENCY }, fxQuoteCurrency: BASE_CURRENCY, fxQuoteMinor: { not: null } },
    select: { amountMinor: true, currency: true, fxQuoteMinor: true, transferPairId: true },
  });
  for (const q of quotes) {
    if (!q.fxQuoteMinor || q.amountMinor === 0n) continue;
    if (q.transferPairId && partners.has(q.transferPairId)) continue;
    add(q.currency, Number(q.fxQuoteMinor) / Number(q.amountMinor));
  }
  const out = new Map<string, FxRate>();
  for (const [currency, rates] of byCur) {
    const sorted = rates.sort((x, y) => x - y);
    out.set(currency, { currency, rate: sorted[Math.floor(sorted.length / 2)], conversions: rates.length });
  }
  return out;
}

interface Countable { type: string; currency: string; amountMinor: bigint; category: string; subcategory: string | null; merchantName: string | null; counterparty: string | null }

export function nairaAt(ctx: FxContext, minor: bigint, currency: string, date: Date): { naira: bigint; conversion: Conversion | null } | null {
  if (currency === BASE_CURRENCY) return { naira: minor, conversion: null };
  const conversion = convertToNgn(ctx, minor, currency, date);
  if (!conversion) return null;
  return { naira: conversion.nairaMinor, conversion };
}

/** Countable rows in a period with amounts in naira at the transaction-date rate. */
async function countableInNaira(userId: string, p: Period, where: object = {}) {
  const [rows, ctx, learned] = await Promise.all([
    db.transaction.findMany({
      where: { userId, ...countable, transactionDate: range(p), ...where },
      select: { type: true, currency: true, amountMinor: true, category: true, subcategory: true, merchantName: true, counterparty: true, transactionDate: true },
    }),
    loadFxContext(userId),
    fxRates(userId),
  ]);
  const converted: (Countable & { naira: bigint; converted: boolean; conversion: Conversion | null })[] = [];
  const unconverted = new Map<string, bigint>();
  const used = new Map<string, FxRate>();
  for (const r of rows) {
    if (r.currency === BASE_CURRENCY) converted.push({ ...r, naira: r.amountMinor, converted: false, conversion: null });
    else {
      const hit = nairaAt(ctx, r.amountMinor, r.currency, r.transactionDate);
      if (hit) {
        converted.push({ ...r, naira: hit.naira, converted: true, conversion: hit.conversion });
        if (hit.conversion) used.set(r.currency, { currency: r.currency, rate: hit.conversion.rate, conversions: (used.get(r.currency)?.conversions ?? 0) + 1, source: hit.conversion.source });
      } else unconverted.set(`${r.currency} ${r.type}`, (unconverted.get(`${r.currency} ${r.type}`) ?? 0n) + r.amountMinor);
    }
  }
  const rates = used.size ? used : learned;
  return { rows: converted, rates, unconverted };
}

export async function summary(userId: string, p: Period) {
  const [{ rows, rates, unconverted }, count] = await Promise.all([
    countableInNaira(userId, p),
    db.transaction.count({ where: { userId, transactionDate: range(p) } }),
  ]);
  // Loan proceeds (FairMoney, Renmoney, a Deel advance) are credits in Debt, not income.
  // A reversed bank charge is a credit in Fees: it is not income, and it reduces what fees cost.
  const feeCredit = (r: { type: string; category: string }) => r.type === "CREDIT" && r.category === "Fees";
  const inc = rows.filter((r) => r.type === "CREDIT" && r.category !== "Debt" && r.category !== "Fees" && r.subcategory !== "Reversal");
  const exp = rows.filter((r) => r.type === "DEBIT" && r.subcategory !== "Reversal");
  const refunds = rows.filter(feeCredit);
  const income = inc.reduce((s, r) => s + r.naira, 0n);
  const expenses = exp.reduce((s, r) => s + r.naira, 0n) - refunds.reduce((s, r) => s + r.naira, 0n);
  return {
    income, expenses, net: income - expenses, savingsRate: savingsRate(income, expenses), count, incomeCount: inc.length, expenseCount: exp.length,
    /** Foreign-currency rates used, so the UI can say "CAD at your rate of ₦964". */
    ratesUsed: [...rates.values()].filter((fx) => rows.some((r) => r.converted && r.currency === fx.currency)),
    /** Foreign-currency amounts with no learned rate yet (not in the naira totals). */
    unconverted: [...unconverted.entries()].map(([k, v]) => ({ currencyAndType: k, totalMinor: v })),
  };
}

export async function balances(userId: string, now = new Date()) {
  const [accounts, ctx] = await Promise.all([
    db.account.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
    loadFxContext(userId),
  ]);
  let total = 0n;
  const unconverted: string[] = [];
  for (const a of accounts) {
    if (a.balanceMinor === null) continue;
    if (a.currency === BASE_CURRENCY) total += a.balanceMinor;
    else {
      const hit = nairaAt(ctx, a.balanceMinor, a.currency, now);
      if (hit) total += hit.naira;
      else unconverted.push(a.currency);
    }
  }
  return { accounts, totalBase: total, unconvertedCurrencies: [...new Set(unconverted)] };
}

function groupSum<T extends { naira: bigint }>(rows: T[], key: (r: T) => string) {
  const m = new Map<string, { total: bigint; count: number }>();
  for (const r of rows) {
    const k = key(r);
    const g = m.get(k) ?? { total: 0n, count: 0 };
    g.total += r.naira;
    g.count++;
    m.set(k, g);
  }
  return [...m.entries()].sort((a, b) => (b[1].total > a[1].total ? 1 : -1));
}

export async function spendingByCategory(userId: string, p: Period) {
  const [{ rows }, { rows: refunds }] = await Promise.all([
    countableInNaira(userId, p, { type: "DEBIT" }),
    countableInNaira(userId, p, { type: "CREDIT", category: "Fees" }),
  ]);
  const grouped = groupSum(rows, (r) => r.category).map(([category, g]) => ({ category, ...g }));
  const refundTotal = refunds.reduce((s, r) => s + r.naira, 0n);
  if (refundTotal !== 0n) {
    const fees = grouped.find((g) => g.category === "Fees");
    if (fees) fees.total -= refundTotal;
    else grouped.push({ category: "Fees", total: -refundTotal, count: 0 });
    grouped.sort((a, b) => (b.total > a.total ? 1 : a.total > b.total ? -1 : 0));
  }
  return grouped;
}

export async function incomeBySubcategory(userId: string, p: Period) {
  const { rows } = await countableInNaira(userId, p, { type: "CREDIT", category: INCOME_CATEGORY });
  return groupSum(rows, (r) => r.subcategory ?? "Other income").map(([subcategory, g]) => ({ subcategory, ...g }));
}

export async function largest(userId: string, p: Period, type: "DEBIT" | "CREDIT", take = 5) {
  return db.transaction.findMany({
    where: {
      userId,
      type,
      currency: BASE_CURRENCY,
      transferPairId: null,
      category: type === "CREDIT" ? { notIn: [OWN_TRANSFER, "Debt"] } : { not: OWN_TRANSFER },
      transactionDate: range(p),
    },
    orderBy: { amountMinor: "desc" },
    take,
  });
}

export async function topMerchants(userId: string, p: Period, take = 8) {
  const { sameName } = await import("./categorize");
  const { rows } = await countableInNaira(userId, p, { type: "DEBIT", merchantName: { not: null } });
  // One entry per person or business: names with 2 of 3 words in common are the same payee.
  const groups: { merchant: string; total: bigint; count: number }[] = [];
  for (const r of rows) {
    const name = r.counterparty ?? r.merchantName!;
    const g = groups.find((x) => x.merchant === name || sameName(x.merchant, name));
    if (g) {
      g.total += r.naira;
      g.count++;
      if (name.length > g.merchant.length) g.merchant = name;
    } else groups.push({ merchant: name, total: r.naira, count: 1 });
  }
  return groups.sort((a, b) => (b.total > a.total ? 1 : -1)).slice(0, take);
}

/** Income and expenses per month for the last `months` months including the current one. */
export async function monthlyTrend(userId: string, now: Date, months = 6) {
  return monthlyTrendFor(userId, lastNMonthsPeriod(now, months));
}

/** Income and expenses for each calendar month in `p`. */
export async function monthlyTrendFor(userId: string, p: Period) {
  const periods = monthsInPeriod(p);
  return Promise.all(
    periods.map(async (m) => {
      const s = await summary(userId, m);
      return { label: m.label.replace(/ \d{4}$/, "").slice(0, 3), period: m, income: s.income, expenses: s.expenses };
    }),
  );
}

/**
 * fixed: about once a month at a similar amount (rent, a subscription). variable: about once a month for 3+ months
 * at amounts that vary (family support, a tailor). frequent: several times a month for 3+ months (Bolt, a buka).
 */
export type RecurringKind = "fixed" | "variable" | "frequent";

export interface RecurringItem {
  key: string;
  name: string;
  category: string;
  /** The user's own label, if any ("Partner", "Mum", "Rent and DD"). */
  label?: string;
  type: "DEBIT" | "CREDIT";
  /** Typical payment; for a frequent payee, a typical month's total. */
  averageMinor: bigint;
  occurrences: number;
  months: number;
  lastDate: Date;
  nextExpected: Date;
  /** The rows in this stream, so callers can tell a regular payment from a one-off. */
  transactionIds: string[];
  kind: RecurringKind;
  /** Other spellings of the payee matched into this stream ("Okeke Chidi", "CHIDI E OKEK"). */
  aliases: string[];
}

const lagosMonth = (d: Date) => new Date(d.getTime() + 3600_000).toISOString().slice(0, 7);
const median = (xs: bigint[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[Math.floor(xs.length / 2)];

/**
 * Regular payments. Groups payments by who received them, matching spellings across narrations (see payees.ts:
 * "TO OPAY - CHIDI EMEKA OKEKE" = "OKEKE CHIDI" = "CHIDI E OKEK", "POS SHOPRITE LEKKI" = "SHOPRITE NIGERIA LTD"),
 * else by the memo the user typed. Within a payee, similar amounts form separate streams, so ₦750K and ₦1M to
 * the same person are two commitments. A stream is regular when it appears in 2+ months, at most about once a
 * month, with a typical gap of 20 to 40 days. What is left of a payee is a variable monthly stream when it still
 * looks monthly over 3+ months, and (with `frequent`) a frequent payee when paid in 3+ months, 4+ times.
 * Frequent payees are opt-in: Afford's fixed obligations and income only use monthly streams.
 */
export const RECURRING_LOOKBACK_MONTHS = 6;

export async function recurring(
  userId: string, now: Date, type: "DEBIT" | "CREDIT" = "DEBIT", lookbackMonths = RECURRING_LOOKBACK_MONTHS, opts: { frequent?: boolean } = {},
): Promise<RecurringItem[]> {
  const { memoOf } = await import("./review");
  const { clusterPayees, payeeKey, payeeName } = await import("./payees");
  const from = monthPeriod(now, -(lookbackMonths - 1)).from;
  const [rows, aliases] = await Promise.all([
    db.transaction.findMany({
      where: { userId, type, ...countable, transactionDate: { gte: from } },
      orderBy: { transactionDate: "asc" },
      select: { id: true, description: true, merchantName: true, counterparty: true, category: true, subcategory: true, classificationSource: true, amountMinor: true, transactionDate: true, currency: true },
    }),
    db.merchantAlias.findMany({ where: { userId, category: { not: null } }, select: { pattern: true, canonicalName: true, category: true, subcategory: true } }),
  ]);

  const ctx = await loadFxContext(userId);
  type Raw = (typeof rows)[number];
  type Row = Raw & { amountMinor: bigint };
  const eligible: Row[] = [];
  for (const r of rows) {
    if (r.category === "Fees" || (type === "CREDIT" && r.category === "Debt")) continue;
    if (type === "CREDIT" && r.subcategory === "Reimbursement") continue;
    if (r.subcategory === "Reversal") continue;
    if (r.currency === BASE_CURRENCY) { eligible.push(r); continue; }
    const hit = nairaAt(ctx, r.amountMinor, r.currency, r.transactionDate);
    if (hit) eligible.push({ ...r, amountMinor: hit.naira });
  }
  const { clusters, unnamed } = clusterPayees(eligible, payeeName, aliases);
  const groups: { key: string; display: string; variants: string[]; alias: { category: string | null; subcategory: string | null } | null; rows: Row[] }[] =
    clusters.map((c) => ({ key: payeeKey(c.name), display: c.name, variants: c.variants, alias: c.alias, rows: c.items }));
  for (const r of unnamed) {
    const key = (memoOf(r.description) ?? learningKey(r.description, null, null)).toLowerCase();
    let g = groups.find((x) => !x.variants.length && x.key === key);
    if (!g) groups.push((g = { key, display: r.merchantName ?? r.description.slice(0, 40), variants: [], alias: null, rows: [] }));
    g.rows.push(r);
  }

  const byDate = (xs: Row[]) => [...xs].sort((x, y) => x.transactionDate.getTime() - y.transactionDate.getTime());
  /** Months seen and the typical gap, when the rows look like a monthly payment. */
  const monthly = (sorted: Row[]) => {
    const months = new Set(sorted.map((r) => lagosMonth(r.transactionDate)));
    if (months.size < 2 || sorted.length > months.size * 2) return undefined; // not monthly, or many small repeats
    // Gaps in whole months: a skipped or late month (61 days) is still a monthly payment.
    const gaps = sorted.slice(1).map((r, i) => (r.transactionDate.getTime() - sorted[i].transactionDate.getTime()) / 86400_000).filter((d) => d > 3);
    const perMonth = gaps.map((d) => d / Math.max(1, Math.round(d / 30.4)));
    const medGap = perMonth.length ? [...perMonth].sort((a, b) => a - b)[Math.floor(perMonth.length / 2)] : 30;
    return medGap < 20 || medGap > 40 ? undefined : { months: months.size, medGap };
  };

  const out: RecurringItem[] = [];
  for (const g of groups) {
    const stream = (sorted: Row[], kind: RecurringKind, months: number, gapDays: number, averageMinor: bigint) => {
      const last = sorted[sorted.length - 1];
      const labelled = [...sorted].reverse().find((r) => r.classificationSource === "user") ?? last;
      out.push({
        key: `${g.key}|${kind === "fixed" ? sorted.reduce((lo, r) => (r.amountMinor < lo ? r.amountMinor : lo), sorted[0].amountMinor) : kind}`,
        name: g.display,
        category: labelled.category,
        // The user's own words for this payee ("Mum", "Partner") beat a generic subcategory.
        label: (g.alias?.category === labelled.category ? g.alias.subcategory : null) ?? labelled.subcategory ?? undefined,
        type,
        averageMinor,
        occurrences: sorted.length,
        months,
        lastDate: last.transactionDate,
        nextExpected: new Date(last.transactionDate.getTime() + Math.round(gapDays) * 86400_000),
        transactionIds: sorted.map((r) => r.id),
        kind,
        aliases: g.variants.filter((v) => v !== g.display),
      });
    };

    const frequent = (left: Row[]) => {
      const perMonth = new Map<string, bigint>();
      for (const r of left) perMonth.set(lagosMonth(r.transactionDate), (perMonth.get(lagosMonth(r.transactionDate)) ?? 0n) + r.amountMinor);
      if (perMonth.size < 3 || left.length < 4) return false;
      const gaps = left.slice(1).map((r, i) => (r.transactionDate.getTime() - left[i].transactionDate.getTime()) / 86400_000).filter((d) => d > 0).sort((a, b) => a - b);
      stream(left, "frequent", perMonth.size, gaps.length ? gaps[Math.floor(gaps.length / 2)] : 7, median([...perMonth.values()]));
      return true;
    };
    // A shop paid at ₦8K, ₦10K and ₦12K every month is one frequent payee, not three monthly bills.
    const all = byDate(g.rows);
    if (opts.frequent && all.length > new Set(all.map((r) => lagosMonth(r.transactionDate))).size * 2 && frequent(all)) continue;

    // Split a payee's payments into amount streams (each amount within 15% of the stream's first).
    const byAmount = [...g.rows].sort((x, y) => (x.amountMinor < y.amountMinor ? -1 : 1));
    const streams: Row[][] = [];
    for (const r of byAmount) {
      const s = streams[streams.length - 1];
      if (s && r.amountMinor * 100n <= s[0].amountMinor * 115n) s.push(r);
      else streams.push([r]);
    }
    const used = new Set<string>();
    for (const s of streams) {
      const sorted = byDate(s);
      const m = monthly(sorted);
      if (!m) continue;
      stream(sorted, "fixed", m.months, m.medGap, median(sorted.map((r) => r.amountMinor)));
      for (const r of s) used.add(r.id);
    }

    // The rest of the payee: still monthly over 3+ months, at amounts within 3x of the typical one.
    const rest = byDate(g.rows.filter((r) => !used.has(r.id)));
    const typical = rest.length ? median(rest.map((r) => r.amountMinor)) : 0n;
    const m = rest.length >= 3 ? monthly(rest) : undefined;
    if (m && m.months >= 3 && rest.every((r) => r.amountMinor * 3n >= typical && r.amountMinor <= typical * 3n)) {
      stream(rest, "variable", m.months, m.medGap, typical);
      for (const r of rest) used.add(r.id);
    }

    if (opts.frequent) frequent(byDate(g.rows.filter((r) => !used.has(r.id))));
  }
  return out.sort((a, b) => (b.averageMinor > a.averageMinor ? 1 : -1));
}

export interface TransactionFilters {
  from?: Date;
  to?: Date;
  type?: "DEBIT" | "CREDIT";
  category?: string;
  q?: string;
  minMinor?: bigint;
  maxMinor?: bigint;
  accountId?: string;
  merchant?: string;
  /** Only these rows (a recurring or one-off view). */
  ids?: string[];
  /** A cadence view (see cadenceWhere), on top of the other filters. */
  cadence?: Prisma.TransactionWhereInput;
  /** One matched person or business, every spelling (see payeeWhere). */
  payee?: Prisma.TransactionWhereInput;
}

export async function listTransactions(userId: string, f: TransactionFilters, page = 1, pageSize = 50) {
  const where = {
    userId,
    ...(f.type && { type: f.type }),
    ...(f.category && { category: f.category }),
    ...(f.accountId && { accountId: f.accountId }),
    ...(f.merchant && { merchantName: f.merchant }),
    ...(f.ids && { id: { in: f.ids } }),
    ...((f.cadence || f.payee) && { AND: [f.cadence, f.payee].filter((w): w is Prisma.TransactionWhereInput => !!w) }),
    ...((f.from || f.to) && { transactionDate: { ...(f.from && { gte: f.from }), ...(f.to && { lt: f.to }) } }),
    ...((f.minMinor !== undefined || f.maxMinor !== undefined) && {
      amountMinor: { ...(f.minMinor !== undefined && { gte: f.minMinor }), ...(f.maxMinor !== undefined && { lte: f.maxMinor }) },
    }),
    ...(f.q && {
      OR: [
        { description: { contains: f.q } },
        { merchantName: { contains: f.q } },
        { counterparty: { contains: f.q } },
        { reference: { contains: f.q } },
      ],
    }),
  };
  const [rows, total] = await Promise.all([
    db.transaction.findMany({ where, orderBy: { transactionDate: "desc" }, skip: (page - 1) * pageSize, take: pageSize, include: { account: true, sources: true } }),
    db.transaction.count({ where }),
  ]);
  return { rows, total, page, pageSize };
}

export class NotFoundError extends Error {}

/** User correction. Also teaches future ingestion via a user-scoped merchant alias. */
export async function recategorize(userId: string, transactionId: string, category: string, subcategory: string | null, applyToSimilar = true) {
  await recategorizeInner(userId, transactionId, category, subcategory, applyToSimilar);
  const { unpairContradicted, pairOwnTransfers } = await import("./transfers");
  if (category === OWN_TRANSFER) await pairOwnTransfers(userId);
  else await unpairContradicted(userId, [transactionId]);
}

async function recategorizeInner(userId: string, transactionId: string, category: string, subcategory: string | null, applyToSimilar: boolean) {
  const tx = await db.transaction.findFirst({ where: { id: transactionId, userId } });
  if (!tx) throw new NotFoundError("transaction not found");
  const pattern = learningKey(tx.description, tx.merchantName, tx.counterparty);
  const canonicalName = tx.merchantName ?? tx.counterparty ?? tx.description.slice(0, 40);
  await db.$transaction([
    db.transaction.update({
      where: { id: tx.id },
      data: { category, subcategory, classificationSource: "user", classificationConfidence: 1 },
    }),
    db.merchantAlias.upsert({
      where: { userId_pattern: { userId, pattern } },
      update: { category, subcategory, canonicalName },
      create: { userId, pattern, canonicalName, category, subcategory },
    }),
    ...(applyToSimilar && (tx.merchantName || tx.counterparty)
      ? [
          db.transaction.updateMany({
            where: {
              userId,
              type: tx.type,
              classificationSource: { not: "user" },
              ...(tx.merchantName ? { merchantName: tx.merchantName } : { counterparty: tx.counterparty }),
            },
            data: { category, subcategory, classificationSource: "user", classificationConfidence: 1 },
          }),
        ]
      : []),
  ]);
}

/** Who paid the user in a period: credits grouped by sender, in naira (foreign income at the user's own rate). */
export async function incomeSources(userId: string, p: Period, take = 6) {
  const { rows } = await countableInNaira(userId, p, { type: "CREDIT" });
  const by = new Map<string, { name: string; kind: string; total: bigint; count: number; currency: string }>();
  for (const r of rows) {
    if (r.category === "Debt" || r.category === "Fees") continue;
    const name = r.merchantName ?? r.counterparty ?? "Unnamed transfers";
    const g = by.get(name) ?? { name, kind: r.subcategory ?? "Other income", total: 0n, count: 0, currency: r.currency };
    g.total += r.naira;
    g.count++;
    by.set(name, g);
  }
  return [...by.values()].sort((a, b) => (b.total > a.total ? 1 : -1)).slice(0, take);
}
