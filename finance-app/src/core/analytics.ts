import { db } from "@/lib/db";
import { INCOME_CATEGORY, OWN_TRANSFER, learningKey } from "./categorize";

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

const range = (p: Period) => ({ gte: p.from, lt: p.to });
const notOwn = { not: OWN_TRANSFER };

/**
 * Rows that count toward income and spending: not an own transfer, and not one leg of a linked
 * movement between the user's accounts (that money is counted once, where it was earned or spent).
 */
const countable = { category: notOwn, transferPairId: null };

export interface FxRate { currency: string; rate: number; conversions: number }

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

/** Countable rows in a period with amounts in naira; foreign-currency rows convert at the user's own rate. */
async function countableInNaira(userId: string, p: Period, where: object = {}) {
  const [rows, rates] = await Promise.all([
    db.transaction.findMany({
      where: { userId, ...countable, transactionDate: range(p), ...where },
      select: { type: true, currency: true, amountMinor: true, category: true, subcategory: true, merchantName: true, counterparty: true },
    }),
    fxRates(userId),
  ]);
  const converted: (Countable & { naira: bigint; converted: boolean })[] = [];
  const unconverted = new Map<string, bigint>();
  for (const r of rows) {
    if (r.currency === BASE_CURRENCY) converted.push({ ...r, naira: r.amountMinor, converted: false });
    else {
      const fx = rates.get(r.currency);
      if (fx) converted.push({ ...r, naira: BigInt(Math.round(Number(r.amountMinor) * fx.rate)), converted: true });
      else unconverted.set(`${r.currency} ${r.type}`, (unconverted.get(`${r.currency} ${r.type}`) ?? 0n) + r.amountMinor);
    }
  }
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
  const inc = rows.filter((r) => r.type === "CREDIT" && r.category !== "Debt" && r.category !== "Fees");
  const exp = rows.filter((r) => r.type === "DEBIT");
  const refunds = rows.filter(feeCredit);
  const income = inc.reduce((s, r) => s + r.naira, 0n);
  const expenses = exp.reduce((s, r) => s + r.naira, 0n) - refunds.reduce((s, r) => s + r.naira, 0n);
  return {
    income, expenses, net: income - expenses, count, incomeCount: inc.length, expenseCount: exp.length,
    /** Foreign-currency rates used, so the UI can say "CAD at your rate of ₦964". */
    ratesUsed: [...rates.values()].filter((fx) => rows.some((r) => r.converted && r.currency === fx.currency)),
    /** Foreign-currency amounts with no learned rate yet (not in the naira totals). */
    unconverted: [...unconverted.entries()].map(([k, v]) => ({ currencyAndType: k, totalMinor: v })),
  };
}

export async function balances(userId: string) {
  const accounts = await db.account.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  const total = accounts.filter((a) => a.currency === BASE_CURRENCY).reduce((s, a) => s + (a.balanceMinor ?? 0n), 0n);
  return { accounts, totalBase: total };
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
  const periods = Array.from({ length: months }, (_, i) => monthPeriod(now, i - (months - 1)));
  return Promise.all(
    periods.map(async (p) => {
      const s = await summary(userId, p);
      return { label: p.label.slice(0, 3), period: p, income: s.income, expenses: s.expenses };
    }),
  );
}

export interface RecurringItem {
  key: string;
  name: string;
  category: string;
  /** The user's own label, if any ("Partner", "Mum", "Rent and DD"). */
  label?: string;
  type: "DEBIT" | "CREDIT";
  averageMinor: bigint;
  occurrences: number;
  months: number;
  lastDate: Date;
  nextExpected: Date;
  /** The rows in this stream, so callers can tell a regular payment from a one-off. */
  transactionIds: string[];
}

const lagosMonth = (d: Date) => new Date(d.getTime() + 3600_000).toISOString().slice(0, 7);

/**
 * Regular payments. Groups by person (names match when 2 of 3 words agree), else merchant, else the
 * memo the user typed. Within a person, similar amounts form separate streams, so ₦750K and ₦1M to
 * the same person are two commitments. A stream is regular when it appears in 2+ months, at most
 * about once a month, with a typical gap of 20 to 40 days.
 */
export const RECURRING_LOOKBACK_MONTHS = 6;

export async function recurring(userId: string, now: Date, type: "DEBIT" | "CREDIT" = "DEBIT", lookbackMonths = RECURRING_LOOKBACK_MONTHS): Promise<RecurringItem[]> {
  const { sameName } = await import("./categorize");
  const { memoOf } = await import("./review");
  const from = monthPeriod(now, -(lookbackMonths - 1)).from;
  const rows = await db.transaction.findMany({
    where: { userId, type, currency: BASE_CURRENCY, ...countable, transactionDate: { gte: from } },
    orderBy: { transactionDate: "asc" },
    select: { id: true, description: true, merchantName: true, counterparty: true, category: true, subcategory: true, classificationSource: true, amountMinor: true, transactionDate: true },
  });

  type Row = (typeof rows)[number];
  const groups: { key: string; display: string; isPerson: boolean; rows: Row[] }[] = [];
  for (const r of rows) {
    if (r.category === "Fees") continue;
    if (type === "CREDIT" && r.category === "Debt") continue;
    const person = r.counterparty && r.counterparty.split(/\s+/).length >= 2 ? r.counterparty : undefined;
    let g = person ? groups.find((x) => x.isPerson && sameName(x.display, person)) : undefined;
    const fallbackKey = (r.merchantName ?? memoOf(r.description) ?? learningKey(r.description, null, null)).toLowerCase();
    if (!person) g = groups.find((x) => !x.isPerson && x.key === fallbackKey);
    if (!g) groups.push((g = { key: person ? person.toLowerCase() : fallbackKey, display: person ?? r.merchantName ?? r.description.slice(0, 40), isPerson: !!person, rows: [] }));
    if (person && person.length > g.display.length) g.display = person;
    g.rows.push(r);
  }

  const aliases = await db.merchantAlias.findMany({ where: { userId, category: { not: null } }, select: { pattern: true, category: true, subcategory: true } });
  const out: RecurringItem[] = [];
  for (const g of groups) {
    // Split a person's payments into amount streams (each amount within 15% of the stream's first).
    const byAmount = [...g.rows].sort((x, y) => (x.amountMinor < y.amountMinor ? -1 : 1));
    const streams: Row[][] = [];
    for (const r of byAmount) {
      const s = streams[streams.length - 1];
      if (s && r.amountMinor * 100n <= s[0].amountMinor * 115n) s.push(r);
      else streams.push([r]);
    }
    for (const s of streams) {
      const sorted = [...s].sort((x, y) => x.transactionDate.getTime() - y.transactionDate.getTime());
      const months = new Set(sorted.map((r) => lagosMonth(r.transactionDate)));
      if (months.size < 2 || sorted.length > months.size * 2) continue; // not monthly, or many small repeats
      // Gaps in whole months: a skipped or late month (61 days) is still a monthly payment.
      const gaps = sorted.slice(1).map((r, i) => (r.transactionDate.getTime() - sorted[i].transactionDate.getTime()) / 86400_000).filter((d) => d > 3);
      const perMonth = gaps.map((d) => d / Math.max(1, Math.round(d / 30.4)));
      const medGap = perMonth.length ? [...perMonth].sort((a, b) => a - b)[Math.floor(perMonth.length / 2)] : 30;
      if (medGap < 20 || medGap > 40) continue;
      const amounts = sorted.map((r) => r.amountMinor).sort((a, b) => (a < b ? -1 : 1));
      const last = sorted[sorted.length - 1];
      const labelled = [...sorted].reverse().find((r) => r.classificationSource === "user") ?? last;
      // The user's own words for this person ("Mum", "Partner") beat a generic subcategory.
      const alias = g.isPerson ? aliases.find((a) => sameName(a.pattern, g.display)) : undefined;
      out.push({
        key: `${g.key}|${amounts[0]}`,
        name: g.display,
        category: labelled.category,
        label: (alias?.category === labelled.category ? alias.subcategory : null) ?? labelled.subcategory ?? undefined,
        type,
        averageMinor: amounts[Math.floor(amounts.length / 2)],
        occurrences: sorted.length,
        months: months.size,
        lastDate: last.transactionDate,
        nextExpected: new Date(last.transactionDate.getTime() + Math.round(medGap) * 86400_000),
        transactionIds: sorted.map((r) => r.id),
      });
    }
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
}

export async function listTransactions(userId: string, f: TransactionFilters, page = 1, pageSize = 50) {
  const where = {
    userId,
    ...(f.type && { type: f.type }),
    ...(f.category && { category: f.category }),
    ...(f.accountId && { accountId: f.accountId }),
    ...(f.merchant && { merchantName: f.merchant }),
    ...(f.ids && { id: { in: f.ids } }),
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
    db.transaction.findMany({ where, orderBy: { transactionDate: "desc" }, skip: (page - 1) * pageSize, take: pageSize, include: { account: true } }),
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
