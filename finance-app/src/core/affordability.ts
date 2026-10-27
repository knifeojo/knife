import { db } from "@/lib/db";
import { formatMoney, parseAmountToMinor } from "@/lib/money";
import { BASE_CURRENCY, monthPeriod, nairaAt, recurring, summary } from "./analytics";
import { INCOME_CATEGORY, OWN_TRANSFER } from "./categorize";
import { loadFxContext } from "./fx/rates";
import {
  addMonths, endOfDay, finishedOn, instalmentsCovered, instalmentsLeft, isFinished, payoffDate, repaymentsSince, sameLender, toManualLoan,
  type ManualLoan,
} from "./loans";

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
/** A repayment to a lender this long after a loan the user entered finished means a new loan, not the old one. */
const NEW_LOAN_AFTER_DAYS = 10;

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
  /** Loans the user entered by hand, open and closed. Missing means none. */
  loans?: ManualLoan[];
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
  /** A loan the user entered: its id and last payment. Nothing is counted after that day. */
  loanId?: string;
  endsOn?: Date | null;
}

/**
 * Money for family (spouse, children, parents, black tax) by Family subcategory. Shown so the owner
 * sees it as an obligation; it never feeds a cut. Informational: the projection uses `obligations`.
 */
export interface FamilyObligationLine {
  /** The Family subcategory ("Spouse", "Black tax"), or "Family" when it has none. */
  label: string;
  /** Average per month over the months behind the typical month. */
  monthlyMinor: bigint;
  /** Months (of those) with at least one payment. */
  months: number;
  /** True when it is also a regular payment counted in the projection. */
  recurring: boolean;
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
  /** Debt only: the balance the user entered, else borrowed minus repaid as far as the ledger shows. null when Ledger cannot tell. */
  openMinor: bigint | null;
  /** Debt only, and only when the user entered this loan. Without it there is no real balance yet. */
  loan?: AdviceLoan;
}

export interface AdviceLoan {
  id: string;
  outstandingMinor: bigint;
  balanceAsOf: Date;
  endsOn: Date | null;
  instalmentsLeft: number | null;
  /** Repaid to this lender on statements after the balance was entered. Both 0 when it is up to date. */
  repaymentsSince: number;
  repaidSinceMinor: bigint;
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
    /** Family support by kind. Treated as an obligation, never as spending to cut. */
    familyObligations: FamilyObligationLine[];
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
/** Balances at a glance: ₦1.28m, ₦450k, or the exact figure under ₦1,000. */
const short = (m: bigint) => {
  if (m >= 99_950_000n) {
    const h = (m + 500_000n) / 1_000_000n;
    const frac = h % 100n ? `.${String(h % 100n).padStart(2, "0").replace(/0$/, "")}` : "";
    return `₦${h / 100n}${frac}m`;
  }
  if (m >= 100_000n) return `₦${(m + 50_000n) / 100_000n}k`;
  return whole(m);
};

/** A dated stream of payments to project: a statement pattern, or a loan's own schedule. */
interface Stream {
  item: RegularItem;
  /** Nothing is due from this instant on (the end of the last payment day). */
  until: number;
  /** At most this many more payments. null when unknown. */
  left: number | null;
  loanId?: string;
  endsOn?: Date | null;
  /** Its payments are already in past spending. A new loan's are not, so they are not taken out of everyday spending. */
  inHistory: boolean;
}

interface OpenLoan {
  loan: ManualLoan;
  payoff: Date | null;
  /** Statement repayments after the balance was entered. */
  since: Dated[];
  sinceMinor: bigint;
}

interface LoanPlan {
  months: MonthFigures[];
  streams: Stream[];
  open: OpenLoan[];
  /** Lenders whose loan the user says is done, with no repayment seen since. Left out of loan advice. */
  finished: string[];
  notes: string[];
}

/**
 * How the loans the user entered change the picture. An open loan replaces the statement pattern for its
 * lender with its own instalment and dates, and stops at its last payment. A finished loan's repayments
 * come out of past months, so they stop counting against cash flow, unless the bank shows a repayment to the
 * same lender well after it finished, which is a new loan.
 */
function planLoans(data: AffordabilityData, start: Date, end: Date): LoanPlan {
  const loans = data.loans ?? [];
  let months = data.months;
  let statement = [...data.obligations];
  const streams: Stream[] = [];
  const open: OpenLoan[] = [];
  const finished: string[] = [];
  const notes: string[] = [];
  const repaymentsTo = (lender: string) => data.lenders.filter((l) => sameLender(l.name, lender)).flatMap((l) => l.repayments);
  const isStream = (o: RegularItem, lender: string) => o.category === "Debt" && sameLender(o.name, lender);
  const hasOpen = (lender: string) => loans.some((l) => l.lender === lender && !isFinished(l, start));

  for (const loan of loans) {
    if (!isFinished(loan, start)) continue;
    const reps = repaymentsTo(loan.lender);
    const done = finishedOn(loan);
    const later = reps.filter((r) => r.date.getTime() > done.getTime() + NEW_LOAN_AFTER_DAYS * DAY_MS);
    if (later.length) {
      const last = later[later.length - 1];
      if (!hasOpen(loan.lender)) notes.push(`Ledger saw ${whole(last.amountMinor)} repaid to ${loan.lender} on ${dayLabel(last.date)}, after the loan you entered ${loan.status === "closed" ? "was closed" : "ended"}. If it is a new loan, add it under Loans.`);
      continue;
    }
    const streamsBefore = statement.length;
    statement = statement.filter((o) => !isStream(o, loan.lender));
    let stripped = false;
    months = months.map((m) => {
      const v = sum(reps.filter((r) => monthOf(r.date) === m.label).map((r) => r.amountMinor));
      if (!v) return m;
      stripped = true;
      return { ...m, spendingMinor: max(0n, m.spendingMinor - v), loanRepaymentsMinor: max(0n, m.loanRepaymentsMinor - v) };
    });
    finished.push(loan.lender);
    if (stripped || statement.length < streamsBefore) {
      const when = loan.status === "closed" ? `closed on ${dayLabel(done)}` : `last payment ${dayLabel(done)}`;
      notes.push(`${loan.lender} is paid off (${when}), so its repayments are left out of your typical month.`);
    }
  }

  const seen = new Set(months.map((m) => m.label));
  const graceStart = start.getTime() - OBLIGATION_GRACE_DAYS * DAY_MS;
  for (const loan of loans) {
    if (isFinished(loan, start)) continue;
    const reps = repaymentsTo(loan.lender);
    const since = repaymentsSince(loan, reps);
    const payoff = payoffDate(loan);
    open.push({ loan, payoff, since, sinceMinor: sum(since.map((r) => r.amountMinor)) });
    const stream = statement.find((o) => isStream(o, loan.lender));
    const until = payoff ? endOfDay(payoff).getTime() : Infinity;
    const amount = loan.instalmentMinor ?? stream?.amountMinor ?? null;
    const inHistory = !!stream || reps.some((r) => seen.has(monthOf(r.date)));
    const label = payoff ? `Loan, last payment ${dayLabel(payoff)}` : "Loan repayment";
    let left = instalmentsLeft(loan);
    let next = loan.nextDueDate;
    if (next) {
      // Repayments the bank shows since the user's update, and due dates long past, are instalments already paid.
      const covered = instalmentsCovered(loan, since);
      next = addMonths(next, covered);
      if (left !== null) left -= covered;
      while (next.getTime() < graceStart && next.getTime() < until) {
        next = addMonths(next, 1);
        if (left !== null) left -= 1;
      }
    } else {
      next = stream?.nextExpected ?? null;
    }
    if (stream) statement = statement.filter((o) => o !== stream);
    if (amount && next && (left === null || left > 0)) {
      const item: RegularItem = { name: loan.lender, category: "Debt", label, amountMinor: amount, lastDate: addMonths(next, -1), nextExpected: next };
      streams.push({ item, until, left, loanId: loan.id, endsOn: payoff, inHistory });
      if (payoff && until < end.getTime()) notes.push(`${loan.lender}'s last payment is on ${dayLabel(payoff)}. Its ${whole(amount)} a month is not counted after that.`);
    }
  }
  streams.unshift(...statement.map((item) => ({ item, until: Infinity, left: null, inHistory: true })));
  return { months, streams, open, finished, notes };
}

/** The middle of 3+ months; with fewer, the cautious end (lowest income, highest spending). */
export function typical(values: bigint[], cautious: "low" | "high"): bigint {
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

/** A loan's instalments: the same calendar day each month. One that is overdue but recent is due at the start. */
function monthlyOccurrences(first: Date, start: number, end: number): number[] {
  const out: number[] = [];
  let t = first;
  if (t.getTime() < start) {
    out.push(start);
    while (t.getTime() < start) t = addMonths(t, 1);
  }
  for (; t.getTime() < end; t = addMonths(t, 1)) out.push(t.getTime());
  return out;
}

export function isActiveObligation(item: RegularItem, start: Date): boolean {
  return item.nextExpected.getTime() >= start.getTime() - OBLIGATION_GRACE_DAYS * DAY_MS;
}

/** One-offs are big single payments outside any regular stream, scaled to the user's income. */
export function oneOffMinimum(monthlyIncomeMinor: bigint): bigint {
  return max(ONE_OFF_FLOOR_MINOR, monthlyIncomeMinor / 10n);
}

/** Typical monthly income behind the answer: the full months only, cautious when there are fewer than 3. */
export function typicalIncome(months: MonthFigures[]): bigint {
  const full = months.filter((m) => !m.partial);
  return full.length ? typical(full.map((m) => m.incomeMinor), "low") : 0n;
}

/**
 * A debit that can be a one-off spend, before size and regularity are checked: naira, not one leg of a
 * move between the user's accounts, not a loan repayment, bank fee or own transfer, not a wallet withdrawal.
 */
export function isOneOffSpend(r: { type: string; currency: string; transferPairId: string | null; category: string; subcategory: string | null }): boolean {
  return r.type === "DEBIT" && r.currency === BASE_CURRENCY && r.transferPairId === null
    && !NOT_ONE_OFF_CATEGORIES.includes(r.category) && !(r.category === "Transfers" && r.subcategory === "Withdrawal");
}
const NOT_ONE_OFF_CATEGORIES = [OWN_TRANSFER, "Fees", "Debt"];

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

  const plan = planLoans(data, start, end);

  // Typical month
  const full = plan.months.filter((m) => !m.partial);
  const partial = full.length ? undefined : plan.months.find((m) => m.partial);
  const scale = (m: MonthFigures, v: bigint) => ceilDiv(v * 30n, BigInt(Math.max(7, m.days)));
  const monthlyIncome = full.length ? typical(full.map((m) => m.incomeMinor), "low") : 0n;
  const monthlySpending = full.length ? typical(full.map((m) => m.spendingMinor), "high") : partial ? scale(partial, partial.spendingMinor) : 0n;
  const monthlyLoans = full.length ? typical(full.map((m) => m.loanRepaymentsMinor), "high") : partial ? scale(partial, partial.loanRepaymentsMinor) : 0n;

  // Fixed obligations
  const active = plan.streams.filter((s) => OBLIGATION_CATEGORIES.includes(s.item.category) && isActiveObligation(s.item, start));
  const out = new Array<bigint>(totalDays + 1).fill(0n);
  const inn = new Array<bigint>(totalDays + 1).fill(0n);
  const obligations: ObligationLine[] = active.map(({ item: o, until, left, loanId, endsOn }) => {
    const stop = Math.min(endMs, until);
    let due = loanId ? monthlyOccurrences(o.nextExpected, startMs, stop) : occurrences(o, startMs, stop, "obligation");
    if (left !== null) due = due.slice(0, left);
    for (const t of due) out[dayOf(t)] += o.amountMinor;
    return {
      name: o.name, category: o.category, label: o.label, monthlyMinor: o.amountMinor,
      dueInWindowMinor: o.amountMinor * BigInt(due.length), nextDue: due.length ? new Date(due[0]) : null, kind: "recurring",
      ...(loanId && { loanId, endsOn: endsOn ?? null }),
    };
  });
  const regularMonthly = sum(active.map((s) => s.item.amountMinor));
  const regularLoans = sum(active.filter((s) => s.item.category === "Debt" && s.inHistory).map((s) => s.item.amountMinor));
  const newLoans = sum(active.filter((s) => !s.inHistory).map((s) => s.item.amountMinor));
  const otherLoans = max(0n, monthlyLoans - regularLoans);
  const monthlyObligations = regularMonthly + otherLoans;
  const monthlyEveryday = max(0n, monthlySpending - (monthlyObligations - newLoans));
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
  notes.push(...plan.notes);

  const oneOffMin = oneOffMinimum(monthlyIncome);
  const oneOffs = data.oneOffs.filter((o) => o.amountMinor >= oneOffMin).sort((a, b) => (b.amountMinor > a.amountMinor ? 1 : b.amountMinor < a.amountMinor ? -1 : 0));
  const lookback = full.length ? full.slice(0, LOOKBACK_MONTHS) : partial ? [partial] : [];
  const familyObligations = familyLines(lookback, obligations);
  const advice = buildAdvice({
    verdict, data, start, now, lastDay, buffer, gap: buffer - lowest, surplus: monthlySurplus, monthsToSave,
    lookback, partialOnly: !full.length, scale, oneOffs, maxCut: monthlyEveryday, loans: plan,
    keepsBuffer: (cut) => project(cut).lowest >= buffer,
  });

  return {
    verdict, headline, detail, notes, amountMinor: amount, description: req.description,
    window: { from: start, to: end, label: windowLabel, days: totalDays, startsAtBalanceDate: start < now },
    inputs: {
      cashMinor: cash, cashKnown, cashAsOf: asOf,
      monthlyIncomeMinor: monthlyIncome, incomeMonths: full.length ? full.slice(0, LOOKBACK_MONTHS).map((m) => m.label) : partial ? [`${partial.label} so far`] : [],
      monthlyObligationsMinor: monthlyObligations, obligations, familyObligations, otherLoanRepaymentsMinor: otherLoans,
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

function familyLines(lookback: MonthFigures[], obligations: ObligationLine[]): FamilyObligationLine[] {
  if (!lookback.length) return [];
  const by = new Map<string, { total: bigint; months: Set<string> }>();
  for (const m of lookback) {
    for (const c of m.categories) {
      if (c.category !== "Family" || c.totalMinor <= 0n) continue;
      const label = c.subcategory ?? "Family";
      const g = by.get(label) ?? { total: 0n, months: new Set<string>() };
      g.total += c.totalMinor;
      g.months.add(m.label);
      by.set(label, g);
    }
  }
  return [...by.entries()]
    .map(([label, g]) => ({
      label, monthlyMinor: g.total / BigInt(lookback.length), months: g.months.size,
      recurring: obligations.some((o) => o.category === "Family" && (o.label ?? "Family") === label),
    }))
    .sort((a, b) => (b.monthlyMinor > a.monthlyMinor ? 1 : b.monthlyMinor < a.monthlyMinor ? -1 : a.label.localeCompare(b.label)));
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
  loans: LoanPlan;
}

interface Lender {
  name: string;
  monthlyMinor: bigint | null;
  borrowedMinor: bigint;
  repaidMinor: bigint;
  openMinor: bigint | null;
  firstBorrowed: Date | null;
  borrowings: number;
  /** The loan the user entered for this lender. Its balance wins over borrowed minus repaid. */
  manual?: OpenLoan;
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
  const unmatched = [...c.loans.open];
  for (const l of c.data.lenders) {
    const at = unmatched.findIndex((o) => sameLender(l.name, o.loan.lender));
    const manual = at >= 0 ? unmatched.splice(at, 1)[0] : undefined;
    if (!manual && c.loans.finished.some((name) => sameLender(l.name, name))) continue;
    const last = Math.max(...[...l.repayments, ...l.proceeds].map((x) => x.date.getTime()));
    if (!manual && !(last >= cutoff)) continue;
    const byMonth = new Map<string, bigint>();
    for (const r of l.repayments) byMonth.set(monthOf(r.date), (byMonth.get(monthOf(r.date)) ?? 0n) + r.amountMinor);
    const paidMonths = labels.map((k) => byMonth.get(k) ?? 0n).filter((v) => v > 0n);
    const first = l.proceeds.length ? new Date(Math.min(...l.proceeds.map((p) => p.date.getTime()))) : null;
    const borrowed = sum(l.proceeds.map((p) => p.amountMinor));
    const repaid = first ? sum(l.repayments.filter((r) => r.date >= first).map((r) => r.amountMinor)) : 0n;
    const monthly = paidMonths.length ? typical(paidMonths, "high") : null;
    out.push({
      name: manual?.loan.lender ?? l.name, monthlyMinor: manual?.loan.instalmentMinor ?? monthly,
      borrowedMinor: borrowed, repaidMinor: repaid, openMinor: manual ? manual.loan.outstandingMinor : borrowed > repaid ? borrowed - repaid : null,
      firstBorrowed: first, borrowings: l.proceeds.length, manual,
    });
  }
  for (const o of unmatched) {
    out.push({
      name: o.loan.lender, monthlyMinor: o.loan.instalmentMinor, borrowedMinor: 0n, repaidMinor: 0n,
      openMinor: o.loan.outstandingMinor, firstBorrowed: null, borrowings: 0, manual: o,
    });
  }
  const rank = (l: Lender) => l.monthlyMinor ?? -1n;
  return out.sort((a, b) => (rank(b) > rank(a) ? 1 : rank(b) < rank(a) ? -1 : 0));
}

function adviceLoan(o: OpenLoan): AdviceLoan {
  return {
    id: o.loan.id, outstandingMinor: o.loan.outstandingMinor, balanceAsOf: o.loan.balanceAsOf, endsOn: o.payoff,
    instalmentsLeft: instalmentsLeft(o.loan), repaymentsSince: o.since.length, repaidSinceMinor: o.sinceMinor,
  };
}

/** A real balance from the user's loan app: "Clear Renmoney: ₦1.28m left, last payment 30 Oct." */
function manualDebtAdvice(l: Lender, o: OpenLoan): AdviceLine {
  const { loan, payoff } = o;
  const m = l.monthlyMinor;
  // The user's own instalment is exact; one read off statements is rounded.
  const monthly = m === null ? "" : loan.instalmentMinor !== null ? whole(m) : `about ${about(m)}`;
  let text = `Clear ${l.name}: ${short(loan.outstandingMinor)} left${payoff ? `, last payment ${dayLabel(payoff)}` : ""}.`;
  const left = instalmentsLeft(loan);
  if (left !== null && loan.instalmentsTotal !== null) text += ` ${left} of ${plural(loan.instalmentsTotal, "instalment")} to go.`;
  if (m !== null) {
    text += payoff
      ? ` After that, ${monthly} a month is free.`
      : ` At ${monthly} a month that takes about ${plural(Number(ceilDiv(loan.outstandingMinor, m)), "more month")}, then that money is free.`;
  }
  text += outOfDate(l.name, o);
  return { kind: "debt", text, subject: l.name, monthlyMinor: m, openMinor: loan.outstandingMinor, loan: adviceLoan(o) };
}

/** " Your bank shows ₦120,000 repaid to Renmoney since …", or "" when the balance is up to date. */
function outOfDate(name: string, o: OpenLoan): string {
  if (!o.since.length) return "";
  const { loan } = o;
  const rest = loan.outstandingMinor > o.sinceMinor ? loan.outstandingMinor - o.sinceMinor : 0n;
  return ` Your bank shows ${whole(o.sinceMinor)} repaid to ${name} since you entered this on ${dayLabel(loan.balanceAsOf)}, so it may be ${rest > 0n ? `down to ${short(rest)}` : "paid off"}. Update it under Loans.`;
}

function debtAdvice(l: Lender): AdviceLine {
  if (l.manual) return manualDebtAdvice(l, l.manual);
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
  const part = cat.monthly * CUT_MAX_PERCENT / 100n;
  const cap = part < c.maxCut ? part : c.maxCut;
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
  const n = saving > 0n ? Number(ceilDiv(c.gap, saving)) : null;
  const then = n === null ? " Your outgoings would still be above your income, so this alone is not enough."
    : c.monthsToSave === null ? ` That leaves you a surplus each month, enough to save the ${about(c.gap)} gap in about ${plural(n, "month")}.`
    : c.monthsToSave > n ? ` With your usual surplus, that saves the ${about(c.gap)} gap in about ${plural(n, "month")} instead of ${c.monthsToSave}.`
    : ` That is ${about(cap)} more each month toward the ${about(c.gap)} gap.`;
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
    if (!l) return [];
    if (l.manual) {
      const { loan, payoff } = l.manual;
      const left = `${short(loan.outstandingMinor)} left${payoff ? ` and the last payment on ${dayLabel(payoff)}` : ""}`;
      const each = loan.instalmentMinor !== null ? whole(l.monthlyMinor!) : `about ${about(l.monthlyMinor!)}`;
      return [{
        kind: "debt", subject: l.name, monthlyMinor: l.monthlyMinor, openMinor: l.openMinor, loan: adviceLoan(l.manual),
        text: `You still repay ${l.name} ${each} a month, with ${left}. Clearing it first leaves more room for what comes next.${outOfDate(l.name, l.manual)}`,
      }];
    }
    return [{
      kind: "debt", subject: l.name, monthlyMinor: l.monthlyMinor, openMinor: l.openMinor,
      text: `You still repay ${l.name} about ${about(l.monthlyMinor!)} a month. Clearing it first leaves more room for what comes next.`,
    }];
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
  const [accounts, first, obligations, income, loans] = await Promise.all([
    db.account.findMany({ where: { userId } }),
    db.transaction.findFirst({ where: { userId }, orderBy: { transactionDate: "asc" }, select: { transactionDate: true } }),
    recurring(userId, now, "DEBIT"),
    recurring(userId, now, "CREDIT"),
    db.loan.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  ]);
  const reported = accounts.filter((a) => a.balanceMinor !== null);
  const ctx = await loadFxContext(userId);
  let cashMinor = 0n;
  let cashAccounts = 0;
  const leftover = new Set<string>();
  const asOf = reported.reduce<Date | null>((d, a) => (a.balanceUpdatedAt && (!d || a.balanceUpdatedAt > d) ? a.balanceUpdatedAt : d), null);
  for (const a of reported) {
    if (a.currency === BASE_CURRENCY) { cashMinor += a.balanceMinor!; cashAccounts++; continue; }
    const hit = nairaAt(ctx, a.balanceMinor!, a.currency, now);
    if (hit) { cashMinor += hit.naira; cashAccounts++; }
    else leftover.add(a.currency);
  }

  const { months, since } = await loadMonths(userId, now, first?.transactionDate ?? null);

  const regularIds = new Set(obligations.flatMap((o) => o.transactionIds));
  const [lenders, oneOffs] = await Promise.all([lenderActivity(userId, now), since ? bigOneOffs(userId, since, regularIds) : []]);
  const item = (r: (typeof obligations)[number]): RegularItem => ({
    name: r.name, category: r.category, label: r.label, amountMinor: r.averageMinor, lastDate: r.lastDate, nextExpected: r.nextExpected,
  });
  return {
    cash: cashAccounts ? { minor: cashMinor, asOf, accounts: cashAccounts } : null,
    otherCurrencies: [...leftover],
    months,
    obligations: obligations.map(item),
    income: income.map(item),
    lenders,
    oneOffs,
    oneOffsSince: since,
    loans: loans.map(toManualLoan),
  };
}

/**
 * The months behind the typical month, newest first: the 3 most recent full months with data in the last
 * 12, or the month in progress when there is no full month yet. `since` is the start of the oldest.
 */
export async function loadMonths(userId: string, now: Date, firstTransaction?: Date | null): Promise<{ months: MonthFigures[]; since: Date | null }> {
  const first = firstTransaction !== undefined ? firstTransaction
    : (await db.transaction.findFirst({ where: { userId }, orderBy: { transactionDate: "asc" }, select: { transactionDate: true } }))?.transactionDate ?? null;
  const months: MonthFigures[] = [];
  let since: Date | null = null;
  if (!first) return { months, since };
  for (let i = 1; i <= SEARCH_MONTHS && months.length < LOOKBACK_MONTHS; i++) {
    const p = monthPeriod(now, -i);
    if (p.to <= first) break;
    const m = await monthFigures(userId, p, false, now);
    if (m) { months.push(m); since = p.from; }
  }
  if (!months.length) {
    const p = monthPeriod(now, 0);
    const m = await monthFigures(userId, p, true, now);
    if (m) { months.push(m); since = p.from; }
  }
  return { months, since };
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
    select: { id: true, type: true, currency: true, transferPairId: true, description: true, merchantName: true, counterparty: true, category: true, subcategory: true, amountMinor: true, transactionDate: true },
  });
  return rows
    .filter((r) => !regularIds.has(r.id) && isOneOffSpend(r))
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
