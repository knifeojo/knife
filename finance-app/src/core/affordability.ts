import { db } from "@/lib/db";
import { formatMoney, parseAmountToMinor } from "@/lib/money";
import { BASE_CURRENCY, monthPeriod, recurring, summary } from "./analytics";
import { INCOME_CATEGORY, OWN_TRANSFER } from "./categorize";

// "Can I really afford this?" Every figure comes from the user's ledger, in integer minor units.
// The judgment calls (which months, which payments count as fixed, how big the buffer is) are
// constants below and are listed back to the user with the answer.

const DAY_MS = 86400_000;

/** Ledger always keeps at least this much aside: ₦50,000. */
export const BUFFER_FLOOR_MINOR = 5_000_000n;
/** Regular payments in these categories are fixed obligations. Other regular spending is everyday spending. */
export const OBLIGATION_CATEGORIES = ["Housing", "Family", "Debt", "Utilities", "Subscriptions", "Business"];
/** Full calendar months used for the typical month. */
export const LOOKBACK_MONTHS = 3;
const SEARCH_MONTHS = 12;
/** A regular payment not seen this many days after it was due is treated as finished. */
const OBLIGATION_GRACE_DAYS = 45;
/** A payday this many days late is treated as stopped, and later paydays are not counted. */
const INCOME_GRACE_DAYS = 10;
export const MAX_HORIZON_DAYS = 120;
export const MAX_AMOUNT_MINOR = 10_000_000_000_000n; // ₦100bn, a typo guard

/** Categories where cutting back is a fair suggestion. Bills, family, health and giving are never suggested. */
export const DISCRETIONARY_CATEGORIES = ["Shopping", "Food", "Transport", "Travel", "Subscriptions"];
/** A spending category is named in advice once it averages at least this a month: ₦20,000. */
export const CUT_MIN_MINOR = 2_000_000n;
/** The most Ledger suggests cutting from one category, as a percentage of it. */
const CUT_MAX_PERCENT = 50n;
/** A single payment outside any regular stream is a one-off from ₦50,000, or a tenth of typical monthly income if that is more. */
export const ONE_OFF_FLOOR_MINOR = 5_000_000n;
const ONE_OFFS_SHOWN = 5;
const MAX_ADVICE = 5;

export type Verdict = "yes" | "stretch" | "no";
export type Horizon = { kind: "month_end" } | { kind: "days"; days: number };

export interface RegularItem {
  name: string;
  category: string;
  label?: string;
  amountMinor: bigint;
  lastDate: Date;
  nextExpected: Date;
}

export interface MonthFigures {
  label: string;
  incomeMinor: bigint;
  spendingMinor: bigint;
  loanRepaymentsMinor: bigint;
  /** Naira debits by category and subcategory, own transfers excluded. */
  categories: CategorySpend[];
  /** The month in progress, used only when there is no full month yet. */
  partial: boolean;
  days: number;
}

export interface CategorySpend {
  category: string;
  subcategory: string | null;
  totalMinor: bigint;
}

export interface Dated {
  date: Date;
  amountMinor: bigint;
}

/** Debt rows for one lender, as the ledger has them: repayments out, loan proceeds in. */
export interface LenderActivity {
  name: string;
  repayments: Dated[];
  proceeds: Dated[];
}

export interface SpendItem {
  name: string;
  category: string;
  label?: string;
  amountMinor: bigint;
  date: Date;
}

export interface AffordabilityData {
  /** Sum of the latest reported naira balances. null when no account has reported one. */
  cash: { minor: bigint; asOf: Date | null; accounts: number } | null;
  otherCurrencies: string[];
  /** Newest first. */
  months: MonthFigures[];
  obligations: RegularItem[];
  income: RegularItem[];
  lenders: LenderActivity[];
  /** Single debits of at least ONE_OFF_FLOOR_MINOR that are not part of a regular stream. Not Debt, Fees or own transfers. */
  oneOffs: SpendItem[];
  /** Start of the oldest month searched for one-offs. */
  oneOffsSince: Date | null;
}

export interface AffordabilityRequest {
  amountMinor: bigint;
  description?: string;
  horizon: Horizon;
  bufferMinor?: bigint;
}

export interface ObligationLine {
  name: string;
  category: string;
  label?: string;
  monthlyMinor: bigint;
  dueInWindowMinor: bigint;
  nextDue: Date | null;
  kind: "recurring";
}

export interface OneOffLine {
  name: string;
  category: string;
  label?: string;
  amountMinor: bigint;
  date: Date;
  kind: "one_off";
}

export type AdviceKind = "debt" | "cut" | "one_off" | "none";

/** One rule-based next step, built from ledger aggregates only. */
export interface AdviceLine {
  kind: AdviceKind;
  text: string;
  /** The lender, spending category or payee the line is about. */
  subject: string | null;
  /** Debt: the usual monthly repayment. Cut: the suggested monthly cut. */
  monthlyMinor: bigint | null;
  /** Debt only: borrowed minus repaid, as far as the ledger shows. null when Ledger cannot tell. */
  openMinor: bigint | null;
}

export interface AffordabilityResult {
  verdict: Verdict;
  headline: string;
  detail: string[];
  notes: string[];
  amountMinor: bigint;
  description?: string;
  window: { from: Date; to: Date; label: string; days: number; startsAtBalanceDate: boolean };
  inputs: {
    cashMinor: bigint;
    cashKnown: boolean;
    cashAsOf: Date | null;
    monthlyIncomeMinor: bigint;
    incomeMonths: string[];
    monthlyObligationsMinor: bigint;
    obligations: ObligationLine[];
    /** Loan repayments seen recently that do not follow a monthly pattern (weekly app repayments, say). */
    otherLoanRepaymentsMinor: bigint;
    monthlyEverydayMinor: bigint;
    monthlySurplusMinor: bigint;
    bufferMinor: bigint;
    bufferRule: "obligations" | "floor" | "yours";
    /** The biggest one-offs, newest search window first by size. Already inside past spending, not counted as recurring. */
    oneOffs: OneOffLine[];
    oneOffsTotalMinor: bigint;
    oneOffMinMinor: bigint;
    oneOffsSince: Date | null;
  };
  projection: {
    incomeInMinor: bigint;
    incomeRule: "paydays" | "monthly" | "none";
    obligationsOutMinor: bigint;
    everydayOutMinor: bigint;
    endMinor: bigint;
    lowestMinor: bigint;
    lowestOn: Date;
    lowestWithoutPurchaseMinor: bigint;
    /** Lowest point minus the buffer. Negative means the buffer is touched. */
    headroomMinor: bigint;
  };
  monthsToSave: number | null;
  /** What would help: 2 to 5 lines when the answer is stretch or no, at most one tip when it is yes. */
  advice: AdviceLine[];
}

const ceilDiv = (a: bigint, b: bigint) => (a > 0n ? (a + b - 1n) / b : a / b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);
const fmt = (m: bigint) => formatMoney(m, BASE_CURRENCY);
const dayLabel = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Lagos" });
/** ₦1,300,000 rather than ₦1,300,000.00 when there are no kobo. */
const whole = (m: bigint) => fmt(m).replace(/\.00$/, "");
/** For typical figures: to the nearest ₦1,000, or ₦100 under ₦10,000. */
const about = (m: bigint) => {
  const step = m >= 1_000_000n ? 100_000n : 10_000n;
  return whole(((m + step / 2n) / step) * step);
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const monthOf = (d: Date) => monthPeriod(d, 0).label;

/** The middle of 3+ months; with fewer, the cautious end (lowest income, highest spending). */
function typical(values: bigint[], cautious: "low" | "high"): bigint {
  if (!values.length) return 0n;
  const sorted = [...values.slice(0, LOOKBACK_MONTHS)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted.length >= 3) return sorted[Math.floor(sorted.length / 2)];
  return cautious === "low" ? sorted[0] : sorted[sorted.length - 1];
}

function gapMs(item: RegularItem): number {
  const days = Math.round((item.nextExpected.getTime() - item.lastDate.getTime()) / DAY_MS);
  return Math.min(40, Math.max(20, days)) * DAY_MS;
}

/**
 * When a regular payment falls inside [start, end). An obligation that is overdue but recent is due
 * at the start, then a cycle later. A payday that is late is skipped, never assumed.
 */
function occurrences(item: RegularItem, start: number, end: number, kind: "obligation" | "income"): number[] {
  const gap = gapMs(item);
  let t = item.nextExpected.getTime();
  const grace = (kind === "obligation" ? OBLIGATION_GRACE_DAYS : INCOME_GRACE_DAYS) * DAY_MS;
  if (t < start - grace) return [];
  const out: number[] = [];
  if (t < start) {
    if (kind === "obligation") {
      out.push(start);
      t = start + gap;
    } else {
      while (t < start) t += gap;
    }
  }
  for (; t < end; t += gap) out.push(t);
  return out;
}

export function isActiveObligation(item: RegularItem, start: Date): boolean {
  return item.nextExpected.getTime() >= start.getTime() - OBLIGATION_GRACE_DAYS * DAY_MS;
}

export function windowEnd(now: Date, horizon: Horizon): Date {
  if (horizon.kind === "month_end") return monthPeriod(now, 0).to;
  const days = Math.min(MAX_HORIZON_DAYS, Math.max(1, Math.floor(horizon.days)));
  return new Date(now.getTime() + days * DAY_MS);
}

export function assessAffordability(data: AffordabilityData, req: AffordabilityRequest, now: Date): AffordabilityResult {
  const amount = req.amountMinor;
  const end = windowEnd(now, req.horizon);
  const cashKnown = data.cash !== null;
  const cash = data.cash?.minor ?? 0n;
  const asOf = data.cash?.asOf ?? null;
  // Start where the balance was read, so spending since then is estimated rather than ignored.
  const start = cashKnown && asOf && asOf < now ? asOf : now;
  const startMs = start.getTime(), endMs = end.getTime();
  const totalDays = Math.max(1, Math.ceil((endMs - startMs) / DAY_MS));
  const dayOf = (t: number) => Math.min(totalDays, Math.max(0, Math.floor((t - startMs) / DAY_MS)));
  const purchaseDay = dayOf(now.getTime());

  // Typical month
  const full = data.months.filter((m) => !m.partial);
  const partial = full.length ? undefined : data.months.find((m) => m.partial);
  const scale = (m: MonthFigures, v: bigint) => ceilDiv(v * 30n, BigInt(Math.max(7, m.days)));
  const monthlyIncome = full.length ? typical(full.map((m) => m.incomeMinor), "low") : 0n;
  const monthlySpending = full.length ? typical(full.map((m) => m.spendingMinor), "high") : partial ? scale(partial, partial.spendingMinor) : 0n;
  const monthlyLoans = full.length ? typical(full.map((m) => m.loanRepaymentsMinor), "high") : partial ? scale(partial, partial.loanRepaymentsMinor) : 0n;

  // Fixed obligations
  const active = data.obligations.filter((o) => OBLIGATION_CATEGORIES.includes(o.category) && isActiveObligation(o, start));
  const out = new Array<bigint>(totalDays + 1).fill(0n);
  const inn = new Array<bigint>(totalDays + 1).fill(0n);
  const obligations: ObligationLine[] = active.map((o) => {
    const due = occurrences(o, startMs, endMs, "obligation");
    for (const t of due) out[dayOf(t)] += o.amountMinor;
    return {
      name: o.name, category: o.category, label: o.label, monthlyMinor: o.amountMinor,
      dueInWindowMinor: o.amountMinor * BigInt(due.length), nextDue: due.length ? new Date(due[0]) : null, kind: "recurring",
    };
  });
  const regularMonthly = sum(active.map((o) => o.amountMinor));
  const regularLoans = sum(active.filter((o) => o.category === "Debt").map((o) => o.amountMinor));
  const otherLoans = max(0n, monthlyLoans - regularLoans);
  const monthlyObligations = regularMonthly + otherLoans;
  const monthlyEveryday = max(0n, monthlySpending - monthlyObligations);
  const monthlySurplus = monthlyIncome - monthlyObligations - monthlyEveryday;

  // Income coming in: dated paydays when Ledger has found them, else one typical month per full 30 days ahead.
  const paydays = data.income.filter((i) => i.category === INCOME_CATEGORY);
  let incomeRule: AffordabilityResult["projection"]["incomeRule"] = "none";
  if (paydays.length) {
    for (const p of paydays) for (const t of occurrences(p, startMs, endMs, "income")) inn[dayOf(t)] += p.amountMinor;
    incomeRule = "paydays";
  } else if (monthlyIncome > 0n) {
    for (let t = now.getTime() + 30 * DAY_MS; t < endMs; t += 30 * DAY_MS) inn[dayOf(t)] += monthlyIncome;
    incomeRule = "monthly";
  }

  // Buffer
  const defaultBuffer = max(BUFFER_FLOOR_MINOR, monthlyObligations);
  const buffer = req.bufferMinor !== undefined ? max(BUFFER_FLOOR_MINOR, req.bufferMinor) : defaultBuffer;
  const bufferRule = req.bufferMinor !== undefined && req.bufferMinor >= BUFFER_FLOOR_MINOR ? "yours" : buffer === BUFFER_FLOOR_MINOR ? "floor" : "obligations";

  // Day by day: outgoings land before income on the same day, so the low point is never flattered.
  // `cut` is a monthly reduction in everyday spending from today on. It is 0 for the answer and only sizes advice.
  const daily = monthlyEveryday + otherLoans;
  const spentBy = (d: number) => ceilDiv(daily * BigInt(d), 30n);
  const project = (cut: bigint) => {
    const outBy = (d: number) => spentBy(d) - (d > purchaseDay ? (cut * BigInt(d - purchaseDay)) / 30n : 0n);
    let running = cash, runningBase = cash;
    let lowest = cash, lowestDay = 0, lowestBase = cash;
    for (let d = 0; d <= totalDays; d++) {
      const step = out[d] + (outBy(d) - (d > 0 ? outBy(d - 1) : 0n));
      running -= step + (d === purchaseDay ? amount : 0n);
      runningBase -= step;
      if (running < lowest) { lowest = running; lowestDay = d; }
      if (runningBase < lowestBase) lowestBase = runningBase;
      running += inn[d];
      runningBase += inn[d];
    }
    return { running, lowest, lowestDay, lowestBase };
  };
  const { running, lowest, lowestDay, lowestBase } = project(0n);
  const lowestOn = new Date(startMs + lowestDay * DAY_MS);
  const headroom = lowest - buffer;
  const verdict: Verdict = lowest >= buffer ? "yes" : lowest >= 0n ? "stretch" : "no";
  const monthsToSave = verdict !== "yes" && monthlySurplus > 0n ? Number(ceilDiv(buffer - lowest, monthlySurplus)) : null;

  const lastDay = new Date(endMs - 1);
  const windowLabel = req.horizon.kind === "month_end" ? `to the end of the month (${dayLabel(lastDay)})` : `over the next ${Math.round((endMs - now.getTime()) / DAY_MS)} days (to ${dayLabel(lastDay)})`;
  const what = req.description ? ` for ${req.description}` : "";
  const headline =
    verdict === "yes" ? `Yes. After paying ${fmt(amount)}${what}, you would keep at least ${fmt(lowest)} ${windowLabel}, above your ${fmt(buffer)} safety buffer.`
    : verdict === "stretch" ? `It's a stretch. You could pay ${fmt(amount)}${what}, but your cash would drop to ${fmt(lowest)} around ${dayLabel(lowestOn)}, below your ${fmt(buffer)} safety buffer.`
    : `Not right now. Paying ${fmt(amount)}${what} would leave you ${fmt(-lowest)} short around ${dayLabel(lowestOn)}.`;

  const detail: string[] = [];
  if (verdict !== "yes") {
    if (lowestBase < buffer) detail.push(`Even without this purchase, your cash would dip to ${fmt(lowestBase)}.`);
    if (monthsToSave !== null) detail.push(`At your usual surplus of ${fmt(monthlySurplus)} a month, about ${monthsToSave} month${monthsToSave === 1 ? "" : "s"} of saving would cover it and keep your buffer.`);
    else detail.push("Your usual month has no surplus, so saving up for this means spending less or earning more first.");
  }

  const notes: string[] = [];
  if (!cashKnown) notes.push("No account balance on file, so Ledger starts from ₦0. Import a recent statement to count your cash.");
  else if (asOf && now.getTime() - asOf.getTime() > 7 * DAY_MS) notes.push(`Your balance is from ${dayLabel(asOf)}. Spending since then is estimated from your typical month.`);
  if (data.otherCurrencies.length) notes.push(`${data.otherCurrencies.join(", ")} balances are not counted.`);
  if (!full.length) notes.push("Less than one full month of history, so income is not counted yet.");
  else if (full.length < LOOKBACK_MONTHS) notes.push(`Based on ${full.length} full month${full.length === 1 ? "" : "s"}. Until there are ${LOOKBACK_MONTHS}, Ledger uses your lowest income month and highest spending month.`);
  if (full.length && monthlyIncome === 0n) notes.push("No income found in your recent months.");
  if (monthlySurplus < 0n) notes.push("Your usual outgoings are more than your usual income.");
  if (monthlyIncome > 0n && amount >= monthlyIncome) notes.push("This costs more than a month of your income.");
  if (incomeRule === "monthly") notes.push("No regular payday found, so Ledger counts one typical month of income for each full 30 days ahead.");
  if (otherLoans > 0n) notes.push(`${fmt(otherLoans)} a month of loan repayments does not follow a monthly pattern and is spread across the days ahead.`);

  // One-offs: big single payments outside any regular stream, scaled to the user's income.
  const oneOffMin = max(ONE_OFF_FLOOR_MINOR, monthlyIncome / 10n);
  const oneOffs = data.oneOffs.filter((o) => o.amountMinor >= oneOffMin).sort((a, b) => (b.amountMinor > a.amountMinor ? 1 : b.amountMinor < a.amountMinor ? -1 : 0));
  const lookback = full.length ? full.slice(0, LOOKBACK_MONTHS) : partial ? [partial] : [];
  const advice = buildAdvice({
    verdict, data, start, now, lastDay, buffer, gap: buffer - lowest, surplus: monthlySurplus, monthsToSave,
    lookback, partialOnly: !full.length, scale, oneOffs, maxCut: monthlyEveryday,
    keepsBuffer: (cut) => project(cut).lowest >= buffer,
  });

  return {
    verdict, headline, detail, notes, amountMinor: amount, description: req.description,
    window: { from: start, to: end, label: windowLabel, days: totalDays, startsAtBalanceDate: start < now },
    inputs: {
      cashMinor: cash, cashKnown, cashAsOf: asOf,
      monthlyIncomeMinor: monthlyIncome, incomeMonths: full.length ? full.slice(0, LOOKBACK_MONTHS).map((m) => m.label) : partial ? [`${partial.label} so far`] : [],
      monthlyObligationsMinor: monthlyObligations, obligations, otherLoanRepaymentsMinor: otherLoans,
      monthlyEverydayMinor: monthlyEveryday, monthlySurplusMinor: monthlySurplus,
      bufferMinor: buffer, bufferRule,
      oneOffs: oneOffs.slice(0, ONE_OFFS_SHOWN).map((o) => ({ name: o.name, category: o.category, label: o.label, amountMinor: o.amountMinor, date: o.date, kind: "one_off" as const })),
      oneOffsTotalMinor: sum(oneOffs.map((o) => o.amountMinor)), oneOffMinMinor: oneOffMin, oneOffsSince: data.oneOffsSince,
    },
    projection: {
      incomeInMinor: sum(inn), incomeRule,
      obligationsOutMinor: sum(out), everydayOutMinor: spentBy(totalDays),
      endMinor: running, lowestMinor: lowest, lowestOn, lowestWithoutPurchaseMinor: lowestBase, headroomMinor: headroom,
    },
    monthsToSave,
    advice,
  };
}

interface AdviceContext {
  verdict: Verdict;
  data: AffordabilityData;
  start: Date;
  now: Date;
  lastDay: Date;
  buffer: bigint;
  /** Buffer minus the lowest point: how far short the answer is. Positive unless the verdict is yes. */
  gap: bigint;
  surplus: bigint;
  monthsToSave: number | null;
  /** The months behind the typical month, newest first. */
  lookback: MonthFigures[];
  partialOnly: boolean;
  scale: (m: MonthFigures, v: bigint) => bigint;
  oneOffs: SpendItem[];
  /** A cut can never be more than everyday spending. */
  maxCut: bigint;
  /** Re-runs the same day-by-day projection with everyday spending cut by this much a month from today. */
  keepsBuffer: (cut: bigint) => boolean;
}

interface Lender {
  name: string;
  monthlyMinor: bigint | null;
  borrowedMinor: bigint;
  repaidMinor: bigint;
  openMinor: bigint | null;
  firstBorrowed: Date | null;
  borrowings: number;
}

/**
 * Lenders still being repaid. Monthly repayment: the typical full month that had a repayment (so weekly
 * repayments add up). Open: borrowed minus repaid since the first loan Ledger saw, which is a floor on the
 * principal left because repayments include interest. No loan seen paid out, or more repaid than borrowed:
 * Ledger cannot tell, and says so.
 */
function activeLenders(c: AdviceContext): Lender[] {
  const cutoff = c.start.getTime() - OBLIGATION_GRACE_DAYS * DAY_MS;
  const labels = c.partialOnly ? [] : c.lookback.map((m) => m.label);
  const out: Lender[] = [];
  for (const l of c.data.lenders) {
    const last = Math.max(...[...l.repayments, ...l.proceeds].map((x) => x.date.getTime()));
    if (!(last >= cutoff)) continue;
    const byMonth = new Map<string, bigint>();
    for (const r of l.repayments) byMonth.set(monthOf(r.date), (byMonth.get(monthOf(r.date)) ?? 0n) + r.amountMinor);
    const paidMonths = labels.map((k) => byMonth.get(k) ?? 0n).filter((v) => v > 0n);
    const first = l.proceeds.length ? new Date(Math.min(...l.proceeds.map((p) => p.date.getTime()))) : null;
    const borrowed = sum(l.proceeds.map((p) => p.amountMinor));
    const repaid = first ? sum(l.repayments.filter((r) => r.date >= first).map((r) => r.amountMinor)) : 0n;
    out.push({
      name: l.name, monthlyMinor: paidMonths.length ? typical(paidMonths, "high") : null,
      borrowedMinor: borrowed, repaidMinor: repaid, openMinor: borrowed > repaid ? borrowed - repaid : null,
      firstBorrowed: first, borrowings: l.proceeds.length,
    });
  }
  const rank = (l: Lender) => l.monthlyMinor ?? -1n;
  return out.sort((a, b) => (rank(b) > rank(a) ? 1 : rank(b) < rank(a) ? -1 : 0));
}

function debtAdvice(l: Lender): AdviceLine {
  const m = l.monthlyMinor;
  let text: string;
  if (l.openMinor !== null) {
    const when = `${l.borrowings === 1 ? "on" : "since"} ${dayLabel(l.firstBorrowed!)}`;
    const paid = l.repaidMinor > 0n ? `${whole(l.repaidMinor)} repaid since` : "nothing repaid yet";
    const months = m ? ` At ${about(m)} a month that takes at least ${plural(Number(ceilDiv(l.openMinor, m)), "more month")}, then that money is free.` : "";
    text = `Clear ${l.name} first: at least ${whole(l.openMinor)} is still open (${whole(l.borrowedMinor)} borrowed ${when}, ${paid}, interest not counted).${months}`;
  } else {
    const unknown = l.borrowedMinor > 0n
      ? `You have repaid more than the ${whole(l.borrowedMinor)} Ledger saw you borrow, so check with ${l.name} for what is left.`
      : `Ledger has not seen this loan paid out, so it cannot tell how much is left. Check with ${l.name}.`;
    text = m ? `Clear ${l.name} first. You repay about ${about(m)} a month. ${unknown} Once it is done, that ${about(m)} a month is free.` : `Clear ${l.name} first. ${unknown}`;
  }
  return { kind: "debt", text, subject: l.name, monthlyMinor: m, openMinor: l.openMinor };
}

function spanLabel(c: AdviceContext): string {
  const names = c.lookback.map((m) => m.label.split(" ")[0]);
  if (!names.length) return "";
  if (c.partialOnly) return `in ${names[0]} so far`;
  return names.length === 1 ? `in ${names[0]}` : `from ${names[names.length - 1]} to ${names[0]}`;
}

/** Discretionary categories by monthly average over the lookback months, with one-offs taken out. */
function spendingToCut(c: AdviceContext) {
  const oneOff = new Map<string, bigint>();
  const key = (month: string, category: string, sub: string | null | undefined) => `${month}|${category}|${sub ?? ""}`;
  for (const o of c.oneOffs) oneOff.set(key(monthOf(o.date), o.category, o.label), (oneOff.get(key(monthOf(o.date), o.category, o.label)) ?? 0n) + o.amountMinor);
  const cats = new Map<string, { total: bigint; subs: Map<string, bigint> }>();
  for (const m of c.lookback) {
    for (const row of m.categories) {
      if (!DISCRETIONARY_CATEGORIES.includes(row.category)) continue;
      const v = max(0n, row.totalMinor - (oneOff.get(key(m.label, row.category, row.subcategory)) ?? 0n));
      const g = cats.get(row.category) ?? { total: 0n, subs: new Map() };
      g.total += v;
      if (row.subcategory) g.subs.set(row.subcategory, (g.subs.get(row.subcategory) ?? 0n) + v);
      cats.set(row.category, g);
    }
  }
  return [...cats.entries()]
    .map(([category, g]) => {
      const monthly = c.partialOnly ? c.scale(c.lookback[0], g.total) : g.total / BigInt(c.lookback.length);
      const [topSub, topTotal] = [...g.subs.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1))[0] ?? [null, 0n];
      return { category, monthly, name: topSub && topTotal * 2n >= g.total ? `${category} (mostly ${topSub.toLowerCase()})` : category };
    })
    .filter((x) => x.monthly >= CUT_MIN_MINOR)
    .sort((a, b) => (b.monthly > a.monthly ? 1 : b.monthly < a.monthly ? -1 : 0));
}

/** Smallest monthly cut, in whole ₦1,000s, that keeps the buffer through the window. null when even the cap does not. */
function cutThatKeepsBuffer(c: AdviceContext, cap: bigint): bigint | null {
  if (!c.keepsBuffer(cap)) return null;
  const step = 100_000n;
  // A cut of 0 fails (the answer is not yes), and a cut of the cap rounded up passes.
  let lo = 0n, hi = ceilDiv(cap, step);
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (c.keepsBuffer(mid * step)) hi = mid;
    else lo = mid;
  }
  return hi * step;
}

function cutAdvice(c: AdviceContext, cat: { category: string; monthly: bigint; name: string }): AdviceLine | null {
  const cap = cat.monthly * CUT_MAX_PERCENT / 100n < c.maxCut ? cat.monthly * CUT_MAX_PERCENT / 100n : c.maxCut;
  if (cap <= 0n) return null;
  const spent = `You spent about ${about(cat.monthly)} a month there ${spanLabel(c)}.`;
  const inWindow = cutThatKeepsBuffer(c, cap);
  if (inWindow !== null) {
    return {
      kind: "cut", subject: cat.category, monthlyMinor: inWindow, openMinor: null,
      text: `Spend about ${whole(inWindow)} a month less on ${cat.name} from today and you stay above your buffer to ${dayLabel(c.lastDay)}. ${spent}`,
    };
  }
  const saving = c.surplus + cap;
  const then = saving > 0n
    ? (() => {
      const n = Number(ceilDiv(c.gap, saving));
      const sooner = c.monthsToSave !== null && c.monthsToSave > n ? ` instead of ${c.monthsToSave}` : "";
      return ` With your usual surplus, that saves the ${about(c.gap)} gap in about ${plural(n, "month")}${sooner}.`;
    })()
    : " Your outgoings would still be above your income, so this alone is not enough.";
  return {
    kind: "cut", subject: cat.category, monthlyMinor: cap, openMinor: null,
    text: `Cut ${cat.name} by about ${about(cap)} a month. ${spent}${then}`,
  };
}

function oneOffAdvice(c: AdviceContext): AdviceLine | null {
  // Annual rent or a family payment is a bill even when Ledger has seen it once, so only spending is suggested here.
  const spends = c.oneOffs.filter((o) => !OBLIGATION_CATEGORIES.includes(o.category));
  if (!spends.length) return null;
  const big = spends[0];
  const total = sum(spends.map((o) => o.amountMinor));
  const text = spends.length === 1
    ? `A one-off spend took ${whole(big.amountMinor)} on ${dayLabel(big.date)} (${big.name}). It is not a bill, so holding off on more like it until you have bought this keeps that cash free.`
    : `One-off spends took ${whole(total)} since ${dayLabel(c.data.oneOffsSince ?? big.date)} (${plural(spends.length, "payment")}, the biggest ${whole(big.amountMinor)} to ${big.name} on ${dayLabel(big.date)}). They are not bills, so holding off on more like them until you have bought this keeps that cash free.`;
  return { kind: "one_off", text, subject: big.name, monthlyMinor: null, openMinor: null };
}

/**
 * What would help, in priority order: loans still being repaid, then discretionary categories to cut,
 * then one-off spends. Every figure comes from the ledger. A yes gets at most one tip.
 */
function buildAdvice(c: AdviceContext): AdviceLine[] {
  const lenders = activeLenders(c);
  if (c.verdict === "yes") {
    const l = lenders.find((x) => x.monthlyMinor !== null);
    return l ? [{
      kind: "debt", subject: l.name, monthlyMinor: l.monthlyMinor, openMinor: l.openMinor,
      text: `You still repay ${l.name} about ${about(l.monthlyMinor!)} a month. Clearing it first leaves more room for what comes next.`,
    }] : [];
  }
  const lines: AdviceLine[] = lenders.slice(0, 2).map(debtAdvice);
  for (const cat of spendingToCut(c).slice(0, 2)) {
    const line = cutAdvice(c, cat);
    if (line) lines.push(line);
  }
  const oneOff = oneOffAdvice(c);
  if (oneOff) lines.push(oneOff);
  if (!lines.length) {
    lines.push({ kind: "none", subject: null, monthlyMinor: null, openMinor: null, text: `Ledger found no loans, big spending categories or one-off spends to point to ${spanLabel(c) || "yet"}.` });
  }
  return lines.slice(0, MAX_ADVICE);
}

/** Reads everything the check needs from the user's ledger. Scoped by the server-derived userId. */
export async function loadAffordabilityData(userId: string, now = new Date()): Promise<AffordabilityData> {
  const [accounts, first, obligations, income] = await Promise.all([
    db.account.findMany({ where: { userId } }),
    db.transaction.findFirst({ where: { userId }, orderBy: { transactionDate: "asc" }, select: { transactionDate: true } }),
    recurring(userId, now, "DEBIT"),
    recurring(userId, now, "CREDIT"),
  ]);
  const reported = accounts.filter((a) => a.balanceMinor !== null);
  const naira = reported.filter((a) => a.currency === BASE_CURRENCY);
  const asOf = naira.reduce<Date | null>((d, a) => (a.balanceUpdatedAt && (!d || a.balanceUpdatedAt > d) ? a.balanceUpdatedAt : d), null);

  const months: MonthFigures[] = [];
  let since: Date | null = null;
  if (first) {
    for (let i = 1; i <= SEARCH_MONTHS && months.length < LOOKBACK_MONTHS; i++) {
      const p = monthPeriod(now, -i);
      if (p.to <= first.transactionDate) break;
      const m = await monthFigures(userId, p, false, now);
      if (m) { months.push(m); since = p.from; }
    }
    if (!months.length) {
      const p = monthPeriod(now, 0);
      const m = await monthFigures(userId, p, true, now);
      if (m) { months.push(m); since = p.from; }
    }
  }

  const regularIds = new Set(obligations.flatMap((o) => o.transactionIds));
  const [lenders, oneOffs] = await Promise.all([lenderActivity(userId, now), since ? bigOneOffs(userId, since, regularIds) : []]);
  const item = (r: (typeof obligations)[number]): RegularItem => ({
    name: r.name, category: r.category, label: r.label, amountMinor: r.averageMinor, lastDate: r.lastDate, nextExpected: r.nextExpected,
  });
  return {
    cash: naira.length ? { minor: sum(naira.map((a) => a.balanceMinor!)), asOf, accounts: naira.length } : null,
    otherCurrencies: [...new Set(reported.filter((a) => a.currency !== BASE_CURRENCY).map((a) => a.currency))],
    months,
    obligations: obligations.map(item),
    income: income.map(item),
    lenders,
    oneOffs,
    oneOffsSince: since,
  };
}

/**
 * Debt rows grouped by lender over the search window. "LOAN TO <name>" memos (subcategory Loans) are left
 * out: the narration cannot say whether the user lent or borrowed, so Ledger does not tell them to clear it.
 */
async function lenderActivity(userId: string, now: Date): Promise<LenderActivity[]> {
  const rows = await db.transaction.findMany({
    where: { userId, category: "Debt", currency: BASE_CURRENCY, transferPairId: null, transactionDate: { gte: monthPeriod(now, -(SEARCH_MONTHS - 1)).from } },
    orderBy: { transactionDate: "asc" },
    select: { type: true, amountMinor: true, transactionDate: true, merchantName: true, counterparty: true, subcategory: true },
  });
  const by = new Map<string, LenderActivity>();
  for (const r of rows) {
    const name = r.merchantName ?? r.counterparty;
    if (!name || (r.type === "DEBIT" && r.subcategory === "Loans")) continue;
    const l = by.get(name.toLowerCase()) ?? { name, repayments: [], proceeds: [] };
    (r.type === "CREDIT" ? l.proceeds : l.repayments).push({ date: r.transactionDate, amountMinor: r.amountMinor });
    by.set(name.toLowerCase(), l);
  }
  return [...by.values()];
}

/** Big single debits since `since` that are not part of a regular stream. A wallet withdrawal to the user's bank is not a spend. */
async function bigOneOffs(userId: string, since: Date, regularIds: Set<string>): Promise<SpendItem[]> {
  const rows = await db.transaction.findMany({
    where: {
      userId, type: "DEBIT", currency: BASE_CURRENCY, transferPairId: null, category: { notIn: [OWN_TRANSFER, "Fees", "Debt"] },
      amountMinor: { gte: ONE_OFF_FLOOR_MINOR }, transactionDate: { gte: since },
    },
    orderBy: { amountMinor: "desc" },
    take: 100,
    select: { id: true, description: true, merchantName: true, counterparty: true, category: true, subcategory: true, amountMinor: true, transactionDate: true },
  });
  return rows
    .filter((r) => !regularIds.has(r.id) && !(r.category === "Transfers" && r.subcategory === "Withdrawal"))
    .map((r) => ({
      name: r.merchantName ?? r.counterparty ?? r.description.slice(0, 40), category: r.category, label: r.subcategory ?? undefined,
      amountMinor: r.amountMinor, date: r.transactionDate,
    }));
}

async function monthFigures(userId: string, p: ReturnType<typeof monthPeriod>, partial: boolean, now: Date): Promise<MonthFigures | null> {
  const range = { gte: p.from, lt: p.to };
  const [s, loans, categories] = await Promise.all([
    summary(userId, p),
    db.transaction.aggregate({
      where: { userId, type: "DEBIT", category: "Debt", currency: BASE_CURRENCY, transferPairId: null, transactionDate: range },
      _sum: { amountMinor: true },
    }),
    db.transaction.groupBy({
      by: ["category", "subcategory"],
      where: { userId, type: "DEBIT", currency: BASE_CURRENCY, transferPairId: null, category: { not: OWN_TRANSFER }, transactionDate: range },
      _sum: { amountMinor: true },
    }),
  ]);
  if (s.count === 0) return null;
  const days = partial ? Math.max(1, Math.ceil((now.getTime() - p.from.getTime()) / DAY_MS)) : Math.round((p.to.getTime() - p.from.getTime()) / DAY_MS);
  return {
    label: p.label, incomeMinor: s.income, spendingMinor: s.expenses, loanRepaymentsMinor: loans._sum.amountMinor ?? 0n,
    categories: categories.map((c) => ({ category: c.category, subcategory: c.subcategory, totalMinor: c._sum.amountMinor ?? 0n })),
    partial, days,
  };
}

export async function checkAffordability(userId: string, req: AffordabilityRequest, now = new Date()) {
  return assessAffordability(await loadAffordabilityData(userId, now), req, now);
}

type Json<T> = T extends bigint ? string : T extends Date ? string : T extends (infer U)[] ? Json<U>[] : T extends object ? { [K in keyof T]: Json<T[K]> } : T;
/** Wire form shared by the web page and the mobile API: minor units as decimal strings, dates as ISO-8601. */
export type AffordabilityJson = Json<AffordabilityResult>;

export function affordabilityJson(r: AffordabilityResult): AffordabilityJson {
  return JSON.parse(JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/** "2.5m", "500k", "₦1,200,000.50" -> minor units. null for anything else, zero, or above the typo guard. */
export function parseAmountInput(raw: string): bigint | null {
  const m = raw.trim().toLowerCase().replace(/^(₦|ngn|n)\s*/, "").replace(/\s+/g, "").match(/^([\d,]*\.?\d*)(k|m)?$/);
  if (!m || !m[1]) return null;
  const base = parseAmountToMinor(m[1]);
  if (base === null) return null;
  const minor = base * (m[2] === "m" ? 1_000_000n : m[2] === "k" ? 1_000n : 1n);
  return minor > 0n && minor <= MAX_AMOUNT_MINOR ? minor : null;
}

export function cleanDescription(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.replace(/[\p{Cc}\u2013\u2014]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return t || undefined;
}

export function parseHorizon(raw: unknown): Horizon | null {
  if (raw === undefined || raw === null || raw === "" || raw === "month_end") return { kind: "month_end" };
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_HORIZON_DAYS) return null;
  return { kind: "days", days: n };
}
