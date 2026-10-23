import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { BASE_CURRENCY, RECURRING_LOOKBACK_MONTHS, fxRates, monthPeriod, recurring, summary, type Period, type RecurringItem, type RecurringKind } from "./analytics";
import { OBLIGATION_CATEGORIES, isOneOffSpend, loadMonths, oneOffMinimum, typicalIncome } from "./affordability";
import { OWN_TRANSFER } from "./categorize";
import { clusterPayees, payeeName, samePayee } from "./payees";
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
  kind: RecurringKind;
}

export interface CadenceIndex {
  /** Transaction id to the regular stream it belongs to (debits and credits). */
  recurring: Map<string, StreamRef>;
  oneOffMinMinor: bigint;
  /** Rows before this get no label: recurring detection does not look further back, so Ledger cannot tell. */
  since: Date;
  /** The regular streams behind `recurring`, biggest first. */
  streams: RecurringItem[];
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
    // A frequent payee (several times a month) is regular spending, never a bill Afford plans for.
    const bill = s.type === "DEBIT" && s.kind !== "frequent" && OBLIGATION_CATEGORIES.includes(s.category);
    const ref = { name: s.name, category: s.category, bill, nextExpected: s.nextExpected, kind: s.kind };
    for (const id of s.transactionIds) map.set(id, ref);
  }
  return { recurring: map, oneOffMinMinor: oneOffMinimum(monthlyIncomeMinor), since, streams };
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

/** Spending is "dominated" by unlabelled payments, and Review is worth suggesting, from this share of its value. */
export const OPAQUE_REVIEW_PERCENT = 30n;

/** Wire and UI label: a regular payment in a bill category is a "recurring bill". */
export function cadenceLabel(row: CadenceRow, index: CadenceIndex): "recurring_bill" | "recurring" | "one_off" | null {
  const c = cadenceOf(row, index);
  return c === "recurring" && index.recurring.get(row.id)?.bill ? "recurring_bill" : c;
}

export async function loadCadence(userId: string, now = new Date()): Promise<CadenceIndex> {
  const [debits, credits, { months }] = await Promise.all([recurring(userId, now, "DEBIT", undefined, { frequent: true }), recurring(userId, now, "CREDIT"), loadMonths(userId, now)]);
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

/** Every transaction paid to or from this person or business, however the narration spelled them. */
export async function payeeWhere(userId: string, name: string): Promise<Prisma.TransactionWhereInput> {
  const rows = await db.transaction.findMany({
    where: { userId, OR: [{ counterparty: { not: null } }, { merchantName: { not: null } }] },
    select: { id: true, counterparty: true, merchantName: true },
  });
  return { id: { in: rows.filter((r) => { const n = payeeName(r); return !!n && samePayee(n, name); }).map((r) => r.id) } };
}

/** Ids for a recurring, one-off or everyday view of the transactions list. */
export async function cadenceIds(userId: string, index: CadenceIndex, kind: CadenceView): Promise<string[]> {
  if (kind === "recurring") return [...index.recurring.keys()];
  if (kind === "one_off") return oneOffIds(userId, index);
  const rows = await db.transaction.findMany({ where: { userId, ...(await cadenceWhere(userId, index, kind)) }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Review questions that would give unlabelled payments a purpose. Only asked when spending needs it. */
export async function reviewQuestionsFor(userId: string, unlabelled: Unlabelled): Promise<number> {
  if (!unlabelled.needsReview) return 0;
  return (await buildQuestions(userId)).filter((q) => q.kind === "person" || q.kind === "memo").length;
}

export interface EverydayGroup {
  name: string;
  totalMinor: bigint;
  count: number;
}

/** What everyday spending was, by category and by matched payee. */
export interface EverydayBreakdown {
  /** Same as `everydayMinor` (fee refunds netted from Fees, other currencies at the user's rate). */
  totalMinor: bigint;
  count: number;
  /** Biggest first. */
  byCategory: EverydayGroup[];
  /** People and businesses (spellings matched), biggest first, at most 8. Rows with no name are "Unnamed payments". */
  byPayee: EverydayGroup[];
}

/** Payments still on the rules' default Transfers/Other label: the narration named who, not what for. */
export interface Unlabelled {
  count: number;
  totalMinor: bigint;
  /** At least OPAQUE_REVIEW_PERCENT of the month's spending: send the user to Review. */
  needsReview: boolean;
}

/** "What I spent on": one matched person or business, split by pattern. */
export interface PayeeSpend {
  name: string;
  /** The user's own label ("Mum", "Landlord") from Review or a correction. */
  label: string | null;
  /** Where most of the money went. */
  category: string;
  totalMinor: bigint;
  count: number;
  recurringMinor: bigint;
  oneOffMinor: bigint;
  everydayMinor: bigint;
  /** How they are paid regularly, when they are. */
  regular: RecurringKind | null;
  /** Still on the default label: Review can say what these were for. */
  unlabelledMinor: bigint;
  /** Other spellings matched to this payee in the period. */
  variants: string[];
  /** Memo-only or nameless payments, grouped together. */
  unnamed: boolean;
}

export const UNNAMED_PAYEE = "Unnamed payments";

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
  /** Every spending payment grouped by matched payee, biggest first, at most 15. */
  payees: PayeeSpend[];
  unlabelled: Unlabelled;
}

const byTotal = (a: { totalMinor: bigint }, b: { totalMinor: bigint }) => (b.totalMinor > a.totalMinor ? 1 : b.totalMinor < a.totalMinor ? -1 : 0);

/** A month's spending split into recurring bills, other regular payments, one-offs and everyday spending. */
export async function spendingSplit(userId: string, p: Period, index: CadenceIndex): Promise<SpendingSplit> {
  const inPeriod = { userId, transferPairId: null, category: { not: OWN_TRANSFER }, transactionDate: { gte: p.from, lt: p.to } };
  const [s, rows, refunds, rates, aliases] = await Promise.all([
    summary(userId, p),
    db.transaction.findMany({
      where: { ...inPeriod, type: "DEBIT" },
      select: { ...cadenceSelect, description: true, merchantName: true, counterparty: true, classificationSource: true },
    }),
    db.transaction.findMany({ where: { ...inPeriod, type: "CREDIT", category: "Fees" }, select: { amountMinor: true, currency: true } }),
    fxRates(userId),
    db.merchantAlias.findMany({ where: { userId, category: { not: null } }, select: { pattern: true, canonicalName: true, category: true, subcategory: true } }),
  ]);
  // Naira as the Spending total counts it; a currency with no learned rate is left out, as it is there.
  const naira = (r: { amountMinor: bigint; currency: string }) => {
    if (r.currency === BASE_CURRENCY) return r.amountMinor;
    const fx = rates.get(r.currency);
    return fx ? BigInt(Math.round(Number(r.amountMinor) * fx.rate)) : null;
  };
  type Row = (typeof rows)[number];
  type Item = { r: Row; amount: bigint; part: Cadence | "everyday" };
  let bills = 0n, other = 0n, oneOff = 0n;
  const byCategory = new Map<string, { recurringMinor: bigint; oneOffMinor: bigint }>();
  const oneOffs: OneOffSpend[] = [];
  const everydayCats = new Map<string, EverydayGroup>();
  const items: Item[] = [];
  const unlabelled = { count: 0, totalMinor: 0n };
  let everydayCount = 0;
  for (const r of rows) {
    let item: Item;
    if (isEveryday(r, index)) {
      const amount = naira(r);
      if (amount === null) continue;
      everydayCount++;
      const cat = everydayCats.get(r.category) ?? { name: r.category, totalMinor: 0n, count: 0 };
      cat.totalMinor += amount;
      cat.count++;
      everydayCats.set(r.category, cat);
      item = { r, amount, part: "everyday" };
    } else {
      const c = cadenceOf(r, index);
      if (!c) continue;
      item = { r, amount: r.amountMinor, part: c };
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
    items.push(item);
    if (isOpaque(r)) {
      unlabelled.count++;
      unlabelled.totalMinor += item.amount;
    }
  }

  const { clusters, unnamed } = clusterPayees(items, (i) => payeeName(i.r), aliases);
  const groups = [...clusters.map((c) => ({ name: c.name, label: c.label, variants: c.variants, items: c.items, unnamed: false }))];
  if (unnamed.length) groups.push({ name: UNNAMED_PAYEE, label: null, variants: [], items: unnamed, unnamed: true });
  const payees: PayeeSpend[] = groups.map((g) => {
    const sum = (f: (i: Item) => boolean) => g.items.filter(f).reduce((t, i) => t + i.amount, 0n);
    const cats = new Map<string, bigint>();
    for (const i of g.items) cats.set(i.r.category, (cats.get(i.r.category) ?? 0n) + i.amount);
    const regular = g.items.map((i) => index.recurring.get(i.r.id)?.kind).find(Boolean) ?? null;
    return {
      name: g.name,
      label: g.label,
      category: [...cats.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))[0][0],
      totalMinor: sum(() => true),
      count: g.items.length,
      recurringMinor: sum((i) => i.part === "recurring"),
      oneOffMinor: sum((i) => i.part === "one_off"),
      everydayMinor: sum((i) => i.part === "everyday"),
      regular,
      unlabelledMinor: sum((i) => isOpaque(i.r)),
      variants: g.variants.filter((v) => v !== g.name),
      unnamed: g.unnamed,
    };
  }).sort(byTotal);

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
      byPayee: payees.filter((x) => x.everydayMinor > 0n)
        .map((x) => ({ name: x.name, totalMinor: x.everydayMinor, count: groups.find((g) => g.name === x.name)!.items.filter((i) => i.part === "everyday").length }))
        .sort(byTotal).slice(0, 8),
    },
    payees: payees.slice(0, 15),
    unlabelled: {
      ...unlabelled,
      needsReview: unlabelled.count > 0 && s.expenses > 0n && unlabelled.totalMinor * 100n >= s.expenses * OPAQUE_REVIEW_PERCENT,
    },
  };
}
