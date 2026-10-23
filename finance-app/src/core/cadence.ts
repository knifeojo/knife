import { db } from "@/lib/db";
import { BASE_CURRENCY, RECURRING_LOOKBACK_MONTHS, monthPeriod, recurring, summary, type Period, type RecurringItem } from "./analytics";
import { OBLIGATION_CATEGORIES, isOneOffSpend, loadMonths, oneOffMinimum, typicalIncome } from "./affordability";
import { OWN_TRANSFER } from "./categorize";

// Recurring vs one-off wherever spending is shown, with the same rules as the Afford breakdown: a
// "Recurring bill" here is a payment Afford counts as a fixed obligation, and a "One-off" is one it would
// list under One-off spends. Amounts and dates decide this; the category only decides "bill" or not.

export type Cadence = "recurring" | "one_off";

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

/** Ids for a recurring or one-off view of the transactions list. */
export async function cadenceIds(userId: string, index: CadenceIndex, kind: Cadence): Promise<string[]> {
  if (kind === "recurring") return [...index.recurring.keys()];
  const rows = await db.transaction.findMany({
    where: { userId, type: "DEBIT", currency: BASE_CURRENCY, transferPairId: null, amountMinor: { gte: index.oneOffMinMinor }, transactionDate: { gte: index.since } },
    select: cadenceSelect,
  });
  return rows.filter((r) => cadenceOf(r, index) === "one_off").map((r) => r.id);
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
}

/** A month's spending split into recurring bills, other regular payments, one-offs and everyday spending. */
export async function spendingSplit(userId: string, p: Period, index: CadenceIndex): Promise<SpendingSplit> {
  const [s, rows] = await Promise.all([
    summary(userId, p),
    db.transaction.findMany({
      where: { userId, type: "DEBIT", currency: BASE_CURRENCY, transferPairId: null, category: { not: OWN_TRANSFER }, transactionDate: { gte: p.from, lt: p.to } },
      select: { ...cadenceSelect, description: true, merchantName: true, counterparty: true },
    }),
  ]);
  let bills = 0n, other = 0n, oneOff = 0n;
  const byCategory = new Map<string, { recurringMinor: bigint; oneOffMinor: bigint }>();
  const oneOffs: OneOffSpend[] = [];
  for (const r of rows) {
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
  return {
    totalMinor: s.expenses,
    recurringBillsMinor: bills,
    recurringOtherMinor: other,
    oneOffMinor: oneOff,
    everydayMinor: everyday > 0n ? everyday : 0n,
    oneOffMinMinor: index.oneOffMinMinor,
    byCategory,
    oneOffs: oneOffs.sort((a, b) => (b.amountMinor > a.amountMinor ? 1 : b.amountMinor < a.amountMinor ? -1 : 0)).slice(0, 5),
    labelled: p.to > index.since,
  };
}
