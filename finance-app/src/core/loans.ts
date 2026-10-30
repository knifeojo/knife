import type { Loan } from "@prisma/client";
import { db } from "@/lib/db";
import { LENDER_NAMES, canonicalLender } from "./categorize";
import { recordLoanCleared } from "./loan-moments";

// Loans the user types in from their lender's app. A bank statement shows repayments going out but never
// the balance left, so this is the only place Ledger gets a real balance and end date. All rule-based.

/** The same ₦100bn typo guard as Afford. */
const MAX_MINOR = 10_000_000_000_000n;
const MAX_INSTALMENTS = 600;
const NOTES_MAX = 300;

export { LENDER_NAMES };

export interface ManualLoan {
  id: string;
  lender: string;
  /** Null when the loan was inferred and no balance has been seen. */
  outstandingMinor: bigint | null;
  instalmentMinor: bigint | null;
  instalmentsPaid: number | null;
  instalmentsTotal: number | null;
  nextDueDate: Date | null;
  endDate: Date | null;
  status: "open" | "closed";
  /** When the balance was last entered. Repayments on statements after this are not in it yet. */
  balanceAsOf: Date;
  closedAt: Date | null;
}

export interface LoanFields {
  lender: string;
  outstandingMinor: bigint;
  instalmentMinor: bigint | null;
  instalmentsPaid: number | null;
  instalmentsTotal: number | null;
  nextDueDate: Date | null;
  endDate: Date | null;
  notes: string | null;
}

interface Dated {
  date: Date;
  amountMinor: bigint;
}

export function toManualLoan(row: Loan): ManualLoan {
  return {
    id: row.id, lender: row.lender, outstandingMinor: row.outstandingMinor, instalmentMinor: row.instalmentMinor,
    instalmentsPaid: row.instalmentsPaid, instalmentsTotal: row.instalmentsTotal, nextDueDate: row.nextDueDate, endDate: row.endDate,
    status: row.status === "closed" ? "closed" : "open", balanceAsOf: row.balanceAsOf, closedAt: row.closedAt,
  };
}

/** Same calendar day next month, clamped: 31 Jan + 1 month is 28 Feb. Dates are 00:00 UTC. */
export function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}

/** The end of a stored Lagos day (stored at 00:00 UTC, which is 01:00 in Lagos; the day ends 23:00 UTC). */
export const endOfDay = (d: Date) => new Date(d.getTime() + 23 * 3600_000);

export function instalmentsLeft(l: Pick<ManualLoan, "instalmentsPaid" | "instalmentsTotal">): number | null {
  return l.instalmentsTotal !== null && l.instalmentsPaid !== null ? Math.max(0, l.instalmentsTotal - l.instalmentsPaid) : null;
}

/** The last payment: the end date the user gave, or the next due date plus the instalments left after it. */
export function payoffDate(l: ManualLoan): Date | null {
  if (l.endDate) return l.endDate;
  const left = instalmentsLeft(l);
  return l.nextDueDate && left !== null && left > 0 ? addMonths(l.nextDueDate, left - 1) : null;
}

/** Closed, nothing left, or past its last payment: its instalment no longer counts against cash flow. */
export function isFinished(l: ManualLoan, at: Date): boolean {
  if (l.status === "closed" || l.outstandingMinor === 0n || instalmentsLeft(l) === 0) return true;
  const end = payoffDate(l);
  return !!end && endOfDay(end) <= at;
}

/** When the loan stopped needing payments: closed on, else the last payment, else when it was last updated. */
export function finishedOn(l: ManualLoan): Date {
  return l.closedAt ?? payoffDate(l) ?? l.balanceAsOf;
}

/** Statement names ("Renmoney", "RENMONEY MFB") against a loan's canonical lender. */
export function sameLender(name: string, lender: string): boolean {
  return name.trim().toLowerCase() === lender.toLowerCase() || canonicalLender(name) === lender;
}

/** Repayments to the loan's lender that the bank shows after the balance was entered. */
export function repaymentsSince<T extends Dated>(l: Pick<ManualLoan, "balanceAsOf">, repayments: T[]): T[] {
  return repayments.filter((r) => r.date > l.balanceAsOf);
}

/** How many instalments some repayments cover: by amount when the instalment is known, else one per payment. */
export function instalmentsCovered(l: Pick<ManualLoan, "instalmentMinor">, repayments: Dated[]): number {
  if (!repayments.length) return 0;
  const total = repayments.reduce((s, r) => s + r.amountMinor, 0n);
  if (!l.instalmentMinor) return repayments.length;
  return Number((total + l.instalmentMinor / 2n) / l.instalmentMinor);
}

/** Checks fields that have already been read into their types. Returns an error to show, or null. */
export function checkLoanFields(f: LoanFields): string | null {
  if (!LENDER_NAMES.includes(f.lender)) return `Pick a lender Ledger knows: ${LENDER_NAMES.join(", ")}.`;
  if (f.outstandingMinor < 0n || f.outstandingMinor > MAX_MINOR) return "Enter the balance left, like 1,275,846.91.";
  if (f.instalmentMinor !== null && (f.instalmentMinor <= 0n || f.instalmentMinor > MAX_MINOR)) return "Enter the monthly instalment, like 120,000, or leave it empty.";
  const count = (n: number | null) => n === null || (Number.isInteger(n) && n >= 0 && n <= MAX_INSTALMENTS);
  if (!count(f.instalmentsPaid) || !count(f.instalmentsTotal) || f.instalmentsTotal === 0) return `Instalments must be whole numbers up to ${MAX_INSTALMENTS}.`;
  if (f.instalmentsPaid !== null && f.instalmentsTotal !== null && f.instalmentsPaid > f.instalmentsTotal) return "Instalments paid cannot be more than the total.";
  if (f.nextDueDate && f.endDate && f.endDate < f.nextDueDate) return "The last payment cannot be before the next one.";
  if (f.notes !== null && f.notes.length > NOTES_MAX) return `Keep notes under ${NOTES_MAX} characters.`;
  return null;
}

/** "2026-10-30" -> that Lagos day at 00:00 UTC. null for anything else. */
export function parseDay(raw: string): Date | null {
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2100 || d.getUTCMonth() !== Number(m[2]) - 1) return null;
  return d;
}

export function cleanNotes(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  return t || null;
}

const MINOR = /^\d{1,16}$/;

/**
 * The JSON API's form: { lender, outstandingMinor: "127584691", instalmentMinor?: "...", instalmentsPaid?: 11,
 * instalmentsTotal?: 12, nextDueDate?: "2026-10-30", endDate?: "2026-10-30", notes? }. Kobo as strings, days as YYYY-MM-DD.
 */
export function loanFieldsFromJson(b: Record<string, unknown>): { fields: LoanFields } | { error: string } {
  const lender = typeof b.lender === "string" ? canonicalLender(b.lender) : undefined;
  if (!lender) return { error: `lender must be one of: ${LENDER_NAMES.join(", ")}` };
  if (typeof b.outstandingMinor !== "string" || !MINOR.test(b.outstandingMinor)) return { error: "outstandingMinor must be a whole number of kobo, sent as a string" };
  const optMinor = (v: unknown) => (v === undefined || v === null || v === "" ? null : typeof v === "string" && MINOR.test(v) ? BigInt(v) : undefined);
  const optInt = (v: unknown) => (v === undefined || v === null ? null : typeof v === "number" && Number.isInteger(v) ? v : undefined);
  const optDay = (v: unknown) => (v === undefined || v === null || v === "" ? null : typeof v === "string" ? parseDay(v) ?? undefined : undefined);
  const instalmentMinor = optMinor(b.instalmentMinor);
  if (instalmentMinor === undefined) return { error: "instalmentMinor must be a whole number of kobo, sent as a string" };
  const instalmentsPaid = optInt(b.instalmentsPaid), instalmentsTotal = optInt(b.instalmentsTotal);
  if (instalmentsPaid === undefined || instalmentsTotal === undefined) return { error: "instalmentsPaid and instalmentsTotal must be whole numbers" };
  const nextDueDate = optDay(b.nextDueDate), endDate = optDay(b.endDate);
  if (nextDueDate === undefined || endDate === undefined) return { error: "nextDueDate and endDate must be YYYY-MM-DD" };
  if (b.notes !== undefined && b.notes !== null && typeof b.notes !== "string") return { error: "notes must be a string" };
  const fields = { lender, outstandingMinor: BigInt(b.outstandingMinor), instalmentMinor, instalmentsPaid, instalmentsTotal, nextDueDate, endDate, notes: cleanNotes(b.notes) };
  const error = checkLoanFields(fields);
  return error ? { error } : { fields };
}

export interface LoanSmsUpdate {
  at: Date;
  status: string | null;
  outstandingMinor: bigint | null;
}

export interface LoanView {
  loan: Loan;
  payoff: Date | null;
  instalmentsLeft: number | null;
  /** Repayments to this lender the bank shows after the balance was entered. Empty for closed loans. */
  since: Dated[];
  sinceMinor: bigint;
  /** Latest SMS that changed this loan. */
  lastUpdate: LoanSmsUpdate | null;
}

/** Statement repayments to these lenders after `from`, as Afford reads them. "LOAN TO <name>" memos are left out. */
async function lenderRepayments(userId: string, from: Date, lenders: string[]) {
  const rows = await db.transaction.findMany({
    where: { userId, type: "DEBIT", category: "Debt", currency: "NGN", transferPairId: null, transactionDate: { gt: from }, NOT: { subcategory: "Loans" } },
    orderBy: { transactionDate: "asc" },
    select: { amountMinor: true, transactionDate: true, merchantName: true, counterparty: true },
  });
  return rows
    .map((r) => ({ name: r.merchantName ?? r.counterparty ?? "", date: r.transactionDate, amountMinor: r.amountMinor }))
    .filter((r) => lenders.some((l) => sameLender(r.name, l)));
}

/** Open loans first, newest first, each with the statement repayments seen since its balance was entered. */
export async function listLoans(userId: string): Promise<LoanView[]> {
  const loans = await db.loan.findMany({ where: { userId }, orderBy: [{ status: "desc" }, { createdAt: "desc" }] });
  const updates = loans.length
    ? await db.loanUpdate.findMany({
        where: { userId, applied: true, loanId: { in: loans.map((loan) => loan.id) } },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const latest = new Map<string, (typeof updates)[number]>();
  for (const row of updates) {
    if (row.loanId && !latest.has(row.loanId)) latest.set(row.loanId, row);
  }
  const open = loans.filter((l) => l.status !== "closed");
  const from = open.length ? new Date(Math.min(...open.map((l) => l.balanceAsOf.getTime()))) : null;
  const repayments = from ? await lenderRepayments(userId, from, [...new Set(open.map((l) => l.lender))]) : [];
  return loans.map((loan) => {
    const m = toManualLoan(loan);
    const since = loan.status === "closed" ? [] : repaymentsSince(m, repayments.filter((r) => sameLender(r.name, loan.lender)));
    const update = latest.get(loan.id);
    return {
      loan,
      payoff: payoffDate(m),
      instalmentsLeft: instalmentsLeft(m),
      since,
      sinceMinor: since.reduce((s, r) => s + r.amountMinor, 0n),
      lastUpdate: update ? { at: update.createdAt, status: update.status, outstandingMinor: update.outstandingMinor } : null,
    };
  });
}

export async function getLoan(userId: string, id: string): Promise<LoanView | null> {
  return (await listLoans(userId)).find((v) => v.loan.id === id) ?? null;
}

export async function createLoan(userId: string, f: LoanFields, now = new Date()): Promise<Loan> {
  return db.loan.create({ data: { userId, ...f, balanceAsOf: now } });
}

/**
 * Saves an edit. The balance date moves only when the balance, instalments paid or next due date change, so
 * fixing a note does not hide repayments Ledger has not counted yet.
 */
export async function updateLoan(userId: string, id: string, f: LoanFields, now = new Date()): Promise<Loan | null> {
  const old = await db.loan.findFirst({ where: { id, userId } });
  if (!old) return null;
  const rebased = old.outstandingMinor !== f.outstandingMinor || old.instalmentsPaid !== f.instalmentsPaid || old.nextDueDate?.getTime() !== f.nextDueDate?.getTime();
  return db.loan.update({ where: { id }, data: { ...f, ...(rebased && { balanceAsOf: now }) } });
}

export async function setLoanStatus(userId: string, id: string, status: "open" | "closed", now = new Date()): Promise<Loan | null> {
  const old = await db.loan.findFirst({ where: { id, userId } });
  if (!old || old.status === status) return old;
  const updated = await db.loan.update({ where: { id }, data: { status, closedAt: status === "closed" ? now : null, ...(status === "open" && { closeReason: null }) } });
  if (status === "closed") await recordLoanCleared(userId, updated, { closedAt: now, silent: false });
  return updated;
}

export async function deleteLoan(userId: string, id: string): Promise<boolean> {
  return (await db.loan.deleteMany({ where: { id, userId } })).count > 0;
}

/**
 * Counts statement repayments seen since the balance was entered: instalments paid go up, the balance goes down
 * by what was repaid, and the next due date moves on. A balance that reaches zero closes the loan.
 */
export async function countRepayments(userId: string, id: string): Promise<{ loan: Loan; counted: number; repaidMinor: bigint } | null> {
  const view = await getLoan(userId, id);
  if (!view || view.loan.status === "closed" || !view.since.length || view.loan.outstandingMinor === null) return null;
  const { loan, since, sinceMinor } = view;
  const balance = loan.outstandingMinor;
  if (balance === null) return null;
  const n = instalmentsCovered(loan, since);
  const outstanding = balance > sinceMinor ? balance - sinceMinor : 0n;
  const paid = loan.instalmentsPaid === null ? null : Math.min(loan.instalmentsTotal ?? MAX_INSTALMENTS, loan.instalmentsPaid + n);
  const last = since[since.length - 1].date;
  const updated = await db.loan.update({
    where: { id },
    data: {
      outstandingMinor: outstanding, instalmentsPaid: paid,
      nextDueDate: loan.nextDueDate && n > 0 ? addMonths(loan.nextDueDate, n) : loan.nextDueDate,
      balanceAsOf: last,
      ...(outstanding === 0n && { status: "closed", closedAt: last }),
    },
  });
  if (outstanding === 0n && loan.status !== "closed") await recordLoanCleared(userId, updated, { closedAt: last, silent: false });
  return { loan: updated, counted: n, repaidMinor: sinceMinor };
}

const day = (d: Date | null) => d?.toISOString() ?? null;

/** Wire form: kobo as decimal strings, dates as ISO-8601. Fields may be added; clients ignore what they do not know. */
export function loanJson(v: LoanView) {
  const l = v.loan;
  return {
    id: l.id,
    lender: l.lender,
    outstandingMinor: l.outstandingMinor?.toString() ?? null,
    instalmentMinor: l.instalmentMinor?.toString() ?? null,
    instalmentsPaid: l.instalmentsPaid,
    instalmentsTotal: l.instalmentsTotal,
    instalmentsLeft: v.instalmentsLeft,
    nextDueDate: day(l.nextDueDate),
    endDate: day(l.endDate),
    payoffDate: day(v.payoff),
    notes: l.notes,
    status: l.status,
    source: l.source,
    closeReason: l.closeReason,
    firstPayment: day(l.firstPayment),
    totalRepaidMinor: l.totalRepaidMinor?.toString() ?? null,
    balanceAsOf: l.balanceAsOf.toISOString(),
    closedAt: day(l.closedAt),
    repaymentsSince: { count: v.since.length, totalMinor: v.sinceMinor.toString(), lastDate: day(v.since[v.since.length - 1]?.date ?? null) },
    lastUpdate: v.lastUpdate
      ? { at: v.lastUpdate.at.toISOString(), status: v.lastUpdate.status, outstandingMinor: v.lastUpdate.outstandingMinor?.toString() ?? null }
      : null,
  };
}