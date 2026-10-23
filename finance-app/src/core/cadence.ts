import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { BASE_CURRENCY, RECURRING_LOOKBACK_MONTHS, fxRates, monthPeriod, recurring, summary, type Period, type RecurringItem } from "./analytics";
import { OBLIGATION_CATEGORIES, isOneOffSpend, loadMonths, oneOffMinimum, typicalIncome } from "./affordability";
import { OWN_TRANSFER, sameName } from "./categorize";
import { buildQuestions } from "./review";

// Recurring vs one-off wherever spending is shown, with the same rules as the Afford breakdown: a
// "Recurring bill" here is a payment Afford counts as a fixed obligation, and a "One-off" is one it would
// list under One-off spends. Amounts and dates decide this; the category only decides "bill" or not.
// Everyday is every other spending debit in the labelled window: not an own transfer, not one leg of a
// linked move between the user's accounts, not part of a regular stream and not a one-off.

export type Cadence = "recurring" | "one_off";
/** A transactions view: one of the cadences, or everyday spending. */
export type CadenceView = Cadence | "everyday";
export const CADENCE_VIEWS: readonly CadenceView[] = ["recurring", "one_off", "everyday"];

export function parseCadenceView(value: string | null | undefined): CadenceView | undefined {
  return CADENCE_VIEWS.includes(value as CadenceView) ? (value as CadenceView) : undefined;
}

export interface StreamRef {
  name: string;
  category: string;
  /** In a category Afford treats as a fixed obligation (rent, family support, loan instalments, bills). */
  bill: boolean;
  nextExpected: Date;
}

export interface CadenceIndex {
  /** Transaction id to the regular stream it belongs to (debits and credits). */
  recurring: Map<string, StreamRef>;
  oneOffMinMinor: bigint;
  /** Rows before this get no label: recurring detection does not look further back, so Ledger cannot tell. */
  since: Date;
}

export interface CadenceRow {
  id: string;
  type: string;
  currency: string;
  transferPairId: string | null;
  category: string;
  subcategory: string | null;
  amountMinor: bigint;
  transactionDate: Date;
}

export function buildCadenceIndex(streams: RecurringItem[], monthlyIncomeMinor: bigint, since: Date): CadenceIndex {
  const map = new Map<string, StreamRef>();
  for (const s of streams) {
    const ref = { name: s.name, category: s.category, bill: s.type === "DEBIT" && OBLIGATION_CATEGORIES.includes(s.category), nextExpected: s.nextExpected };
    for (const id of s.transactionIds) map.set(id, ref);
  }
  return { recurring: map, oneOffMinMinor: oneOffMinimum(monthlyIncomeMinor), since };
}

export function cadenceOf(row: CadenceRow, index: CadenceIndex): Cadence | null {
  if (index.recurring.has(row.id)) return "recurring";
  if (row.transactionDate >= index.since && row.amountMinor >= index.oneOffMinMinor && isOneOffSpend(row)) return "one_off";
  return null;
}

/** Spending that is neither regular nor a one-off. Foreign-currency debits count; Ledger cannot label rows before `since`. */
export function isEveryday(row: CadenceRow, index: CadenceIndex): boolean {
  return row.type === "DEBIT" && row.transferPairId === null && row.category !== OWN_TRANSFER
    && row.transactionDate >= index.since && cadenceOf(row, index) === null;
}

/** Categories the rules fall back to when a narration says who was paid but not what for. */
export const OPAQUE_CATEGORIES = ["Transfers", "Other"];

/** A payment still on the rules' default label: only the user (Review) or optional AI can say what it was for. */
export function isOpaque(row: { category: string; classificationSource: string }): boolean {
  return row.classificationSource === "default" && OPAQUE_CATEGORIES.includes(row.category);
}

/** Everyday is "dominated" by unlabelled payments, and Review is worth suggesting, from this share of its value. */
export const OPAQUE_REVIEW_PERCENT = 30n;

/** Wire and UI label: a regular payment in a bill category is a "recurring bill". */
export function cadenceLabel(row: CadenceRow, index: CadenceIndex): "recurring_bill" | "recurring" | "one_off" | null {
  const c = cadenceOf(row, index);
  return c === "recurring" && index.recurring.get(row.id)?.bill ? "recurring_bill" : c;
}

export async function loadCadence(userId: string, now = new Date()): Promise<CadenceIndex> {
  const [debits, credits, { months }] = await Promise.all([recurring(userId, now, "DEBIT"), recurring(userId, now, "CREDIT"), loadMonths(userId, now)]);
  return buildCadenceIndex([...debits, ...credits], typicalIncome(months), monthPeriod(now, -(RECURRING_LOOKBACK_MONTHS - 1)).from);
}

const cadenceSelect = { id: true, type: true, currency: true, transferPairId: true, category: true, subcategory: true, amountMinor: true, transactionDate: true } as const;

async function oneOffIds(userId: string, index: CadenceIndex): Promise<string[]> {
  const rows = await db.transaction.findMany({
    where: { userId, type: "DEBIT", currency: BASE_CURRENCY, transferPairId: null, amountMinor: { gte: index.oneOffMinMinor }, transactionDate: { gte: index.since } },
    select: cadenceSelect,
  });
  return rows.filter((r) => cadenceOf(r, index) === "one_off").map((r) => r.id);
}

/**
 * Filter for a recurring, one-off or everyday view of the transactions list. Everyday is written as
 * "spending debits minus the regular and one-off ones" so the id list stays short however busy the account is.
 */
export async function cadenceWhere(userId: string, index: CadenceIndex, kind: CadenceView): Promise<Prisma.TransactionWhereInput> {
  if (kind === "recurring") return { id: { in: [...index.recurring.keys()] } };
  const oneOffs = await oneOffIds(userId, index);
  if (kind === "one_off") return { id: { in: oneOffs } };
  return {
    type: "DEBIT", transferPairId: null, category: { not: OWN_TRANSFER }, transactionDate: { gte: index.since },
    id: { notIn: [...index.recurring.keys(), ...oneOffs] },
  };
}

/** Ids for a recurring, one-off or everyday view of the transactions list. */
export async function cadenceIds(userId: string, index: CadenceIndex, kind: CadenceView): Promise<string[]> {
  if (kind === "recurring") return [...index.recurring.keys()];
  if (kind === "one_off") return oneOffIds(userId, index);
  const rows = await db.transaction.findMany({ where: { userId, ...(await cadenceWhere(userId, index, kind)) }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Review questions that would give unlabelled payments a purpose. Only asked when Everyday needs it. */
export async function everydayReviewQuestions(userId: string, everyday: EverydayBreakdown): Promise<number> {
  if (!everyday.needsReview) return 0;
  return (await buildQuestions(userId)).filter((q) => q.kind === "person" || q.kind === "memo").length;
}

export interface EverydayGroup {
  name: string;
  totalMinor: bigint;
  count: number;
}

/** What everyday spending was: by category and by payee, and how much of it no rule could explain. */
export interface EverydayBreakdown {
  /** Same as `everydayMinor` (fee refunds netted from Fees, other currencies at the user's rate). */
  totalMinor: bigint;
  count: number;
  /** Biggest first. */
  byCategory: EverydayGroup[];
  /** People and businesses, biggest first, at most 8. Rows with no name are "Unnamed payments". */
  byPayee: EverydayGroup[];
  /** Still on the rules' default Transfers/Other label: the narration named no purpose. */
  opaque: { count: number; totalMinor: bigint };
  /** Unlabelled payments are at least OPAQUE_REVIEW_PERCENT of everyday: send the user to Review. */
  needsReview: boolean;
}

export interface OneOffSpend {
  id: string;
  name: string;
  category: string;
  subcategory: string | null;
  amountMinor: bigint;
  date: Date;
}

export interface SpendingSplit {
  /** Same total as the Spending page (fee refunds netted, other currencies at the user's rate). */
  totalMinor: bigint;
  recurringBillsMinor: bigint;
  recurringOtherMinor: bigint;
  oneOffMinor: bigint;
  /** Everything else: the total minus regular payments and one-offs. Never below 0. */
  everydayMinor: bigint;
  oneOffMinMinor: bigint;
  byCategory: Map<string, { recurringMinor: bigint; oneOffMinor: bigint }>;
  /** Biggest first, at most 5. */
  oneOffs: OneOffSpend[];
  /** False when the period is older than recurring detection looks back, so nothing could be labelled. */
  labelled: boolean;
  everyday: EverydayBreakdown;
}

const UNNAMED = "Unnamed payments";
const byTotal = (a: { totalMinor: bigint }, b: { totalMinor: bigint }) => (b.totalMinor > a.totalMinor ? 1 : b.totalMinor < a.totalMinor ? -1 : 0);

/** A month's spending split into recurring bills, other regular payments, one-offs and everyday spending. */
export async function spendingSplit(userId: string, p: Period, index: CadenceIndex): Promise<SpendingSplit> {
  const inPeriod = { userId, transferPairId: null, category: { not: OWN_TRANSFER }, transactionDate: { gte: p.from, lt: p.to } };
  const [s, rows, refunds, rates] = await Promise.all([
    summary(userId, p),
    db.transaction.findMany({
      where: { ...inPeriod, type: "DEBIT" },
      select: { ...cadenceSelect, description: true, merchantName: true, counterparty: true, classificationSource: true },
    }),
    db.transaction.findMany({ where: { ...inPeriod, type: "CREDIT", category: "Fees" }, select: { amountMinor: true, currency: true } }),
    fxRates(userId),
  ]);
  // Naira as the Spending total counts it; a currency with no learned rate is left out, as it is there.
  const naira = (r: { amountMinor: bigint; currency: string }) => {
    if (r.currency === BASE_CURRENCY) return r.amountMinor;
    const fx = rates.get(r.currency);
    return fx ? BigInt(Math.round(Number(r.amountMinor) * fx.rate)) : null;
  };
  let bills = 0n, other = 0n, oneOff = 0n;
  const byCategory = new Map<string, { recurringMinor: bigint; oneOffMinor: bigint }>();
  const oneOffs: OneOffSpend[] = [];
  const everydayCats = new Map<string, EverydayGroup>();
  const payees: EverydayGroup[] = [];
  const opaque = { count: 0, totalMinor: 0n };
  let everydayCount = 0;
  for (const r of rows) {
    if (isEveryday(r, index)) {
      const amount = naira(r);
      if (amount === null) continue;
      everydayCount++;
      const cat = everydayCats.get(r.category) ?? { name: r.category, totalMinor: 0n, count: 0 };
      cat.totalMinor += amount;
      cat.count++;
      everydayCats.set(r.category, cat);
      const name = r.counterparty ?? r.merchantName ?? UNNAMED;
      const payee = payees.find((x) => x.name === name || (name !== UNNAMED && x.name !== UNNAMED && sameName(x.name, name)));
      if (payee) {
        payee.totalMinor += amount;
        payee.count++;
        if (name.length > payee.name.length && payee.name !== UNNAMED) payee.name = name;
      } else payees.push({ name, totalMinor: amount, count: 1 });
      if (isOpaque(r)) {
        opaque.count++;
        opaque.totalMinor += amount;
      }
      continue;
    }
    const c = cadenceOf(r, index);
    if (!c) continue;
    const g = byCategory.get(r.category) ?? { recurringMinor: 0n, oneOffMinor: 0n };
    if (c === "recurring") {
      g.recurringMinor += r.amountMinor;
      if (index.recurring.get(r.id)!.bill) bills += r.amountMinor;
      else other += r.amountMinor;
    } else {
      g.oneOffMinor += r.amountMinor;
      oneOff += r.amountMinor;
      oneOffs.push({ id: r.id, name: r.merchantName ?? r.counterparty ?? r.description.slice(0, 40), category: r.category, subcategory: r.subcategory, amountMinor: r.amountMinor, date: r.transactionDate });
    }
    byCategory.set(r.category, g);
  }
  const everyday = s.expenses - bills - other - oneOff;
  const labelled = p.to > index.since;
  // Reversed bank charges reduce what fees cost, as on the Spending page. Fees are never regular or one-off.
  const refunded = labelled ? refunds.reduce((t, r) => t + (naira(r) ?? 0n), 0n) : 0n;
  if (refunded !== 0n) {
    const fees = everydayCats.get("Fees") ?? { name: "Fees", totalMinor: 0n, count: 0 };
    fees.totalMinor -= refunded;
    everydayCats.set("Fees", fees);
  }
  const everydayTotal = [...everydayCats.values()].reduce((t, g) => t + g.totalMinor, 0n);
  return {
    totalMinor: s.expenses,
    recurringBillsMinor: bills,
    recurringOtherMinor: other,
    oneOffMinor: oneOff,
    everydayMinor: everyday > 0n ? everyday : 0n,
    oneOffMinMinor: index.oneOffMinMinor,
    byCategory,
    oneOffs: oneOffs.sort((a, b) => (b.amountMinor > a.amountMinor ? 1 : b.amountMinor < a.amountMinor ? -1 : 0)).slice(0, 5),
    labelled,
    everyday: {
      totalMinor: everydayTotal > 0n ? everydayTotal : 0n,
      count: everydayCount,
      byCategory: [...everydayCats.values()].sort(byTotal),
      byPayee: payees.sort(byTotal).slice(0, 8),
      opaque,
      needsReview: opaque.count > 0 && everydayTotal > 0n && opaque.totalMinor * 100n >= everydayTotal * OPAQUE_REVIEW_PERCENT,
    },
  };
}
