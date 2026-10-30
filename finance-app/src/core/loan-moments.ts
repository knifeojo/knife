import type { Loan } from "@prisma/client";
import { db } from "@/lib/db";
import { canonicalLender } from "./categorize";
import { closeReason, expectedNext, freedPerMonth, inferLoanDraft, lenderOfRepayment, type RepaymentRow } from "./loan-cleared";

export interface LoanClearedCard {
  id: string;
  loanId: string;
  lender: string;
  totalRepaidMinor: bigint;
  freedPerMonthMinor: bigint;
  closedAt: Date;
  silent: boolean;
}

async function repaymentRows(userId: string): Promise<RepaymentRow[]> {
  const rows = await db.transaction.findMany({
    where: { userId, transferPairId: null, currency: "NGN", OR: [{ type: "DEBIT", category: "Debt" }, { type: "CREDIT" }] },
    select: { type: true, amountMinor: true, transactionDate: true, description: true, merchantName: true, counterparty: true, category: true },
  });
  return rows.map((row) => ({
    date: row.transactionDate,
    amountMinor: row.amountMinor,
    description: row.description,
    merchantName: row.merchantName,
    counterparty: row.counterparty,
    category: row.category,
    type: row.type === "CREDIT" ? "CREDIT" : "DEBIT",
  }));
}

function disbursedAfter(rows: RepaymentRow[], lender: string, last: Date): boolean {
  return rows.some((row) => row.type === "CREDIT" && row.date > last && canonicalLender(`${row.merchantName ?? ""} ${row.counterparty ?? ""} ${row.description}`) === lender);
}

async function ownerName(userId: string): Promise<string | null> {
  return (await db.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? null;
}

/** Create inferred loans from three or more lender repayments that have no Loan row yet. */
export async function inferMissingLoans(userId: string, now = new Date()): Promise<number> {
  const name = await ownerName(userId);
  const existing = await db.loan.findMany({ where: { userId }, select: { lender: true } });
  const have = new Set(existing.map((loan) => loan.lender));
  const rows = await repaymentRows(userId);
  const groups = new Map<string, RepaymentRow[]>();
  for (const row of rows) {
    const lender = lenderOfRepayment(row, name);
    if (!lender || have.has(lender)) continue;
    const list = groups.get(lender) ?? [];
    list.push(row);
    groups.set(lender, list);
  }
  let created = 0;
  for (const [lender, debits] of groups) {
    const last = debits.reduce((d, row) => (row.date > d ? row.date : d), debits[0].date);
    const draft = inferLoanDraft(lender, debits, disbursedAfter(rows, lender, last), now);
    if (!draft) continue;
    const loan = await db.loan.create({
      data: {
        userId,
        lender,
        source: "inferred",
        outstandingMinor: draft.closed ? 0n : draft.instalmentMinor,
        instalmentMinor: draft.instalmentMinor,
        nextDueDate: draft.closed ? null : expectedNext(draft.lastPayment),
        status: draft.closed ? "closed" : "open",
        closedAt: draft.closedAt,
        balanceAsOf: draft.lastPayment,
        firstPayment: draft.firstPayment,
        totalRepaidMinor: draft.totalRepaidMinor,
        notes: "Inferred from repayments",
      },
    });
    created += 1;
    if (draft.closed) await recordLoanCleared(userId, loan, { silent: draft.silent, closedAt: draft.closedAt ?? now, totalRepaidMinor: draft.totalRepaidMinor });
  }
  return created;
}

async function totalsFor(userId: string, lender: string, instalmentMinor: bigint | null): Promise<{ total: bigint; freed: bigint; last: Date | null; disbursementAfter: boolean }> {
  const name = await ownerName(userId);
  const rows = await repaymentRows(userId);
  const debits = rows.filter((row) => lenderOfRepayment(row, name) === lender).sort((a, b) => a.date.getTime() - b.date.getTime());
  const last = debits.at(-1)?.date ?? null;
  return {
    total: debits.reduce((s, row) => s + row.amountMinor, 0n),
    freed: freedPerMonth(debits.map((row) => row.amountMinor), instalmentMinor),
    last,
    disbursementAfter: last ? disbursedAfter(rows, lender, last) : false,
  };
}

/** One event per loan. A second call does not create another row or another notification. */
export async function recordLoanCleared(
  userId: string,
  loan: Pick<Loan, "id" | "lender" | "instalmentMinor">,
  opts: { silent?: boolean; closedAt?: Date; totalRepaidMinor?: bigint } = {},
): Promise<LoanClearedCard> {
  const existing = await db.loanClearedEvent.findUnique({ where: { loanId: loan.id } });
  if (existing) return toCard(existing);
  const totals = await totalsFor(userId, loan.lender, loan.instalmentMinor);
  const row = await db.loanClearedEvent.create({
    data: {
      userId,
      loanId: loan.id,
      lender: loan.lender,
      totalRepaidMinor: opts.totalRepaidMinor ?? totals.total,
      freedPerMonthMinor: totals.freed,
      closedAt: opts.closedAt ?? new Date(),
      silent: opts.silent ?? false,
    },
  });
  return toCard(row);
}

function toCard(row: { id: string; loanId: string; lender: string; totalRepaidMinor: bigint; freedPerMonthMinor: bigint; closedAt: Date; silent: boolean }): LoanClearedCard {
  return { id: row.id, loanId: row.loanId, lender: row.lender, totalRepaidMinor: row.totalRepaidMinor, freedPerMonthMinor: row.freedPerMonthMinor, closedAt: row.closedAt, silent: row.silent };
}

/** Close open loans whose repayments have finished, and fire the moment once. */
export async function closeDueLoans(userId: string, now = new Date()): Promise<void> {
  const name = await ownerName(userId);
  const loans = await db.loan.findMany({ where: { userId, status: "open" } });
  const rows = await repaymentRows(userId);
  for (const loan of loans) {
    const debits = rows.filter((row) => lenderOfRepayment(row, name) === loan.lender).sort((a, b) => a.date.getTime() - b.date.getTime());
    const last = debits.at(-1)?.date ?? null;
    const repaid = debits.reduce((s, row) => s + row.amountMinor, 0n);
    const reason = closeReason({
      source: loan.source === "inferred" ? "inferred" : "manual",
      outstandingMinor: loan.outstandingMinor,
      instalmentsPaid: loan.instalmentsPaid,
      instalmentsTotal: loan.instalmentsTotal,
      lastRepayment: last,
      disbursementAfterLast: last ? disbursedAfter(rows, loan.lender, last) : false,
      now,
    });
    if (!reason) continue;
    const closedAt = reason === "stopped" && last ? last : now;
    await db.loan.update({
      where: { id: loan.id },
      data: {
        status: "closed",
        closedAt,
        outstandingMinor: reason === "zero" ? 0n : loan.outstandingMinor,
        ...(repaid > 0n && { totalRepaidMinor: repaid, firstPayment: loan.firstPayment ?? debits[0]?.date ?? null }),
      },
    });
    await recordLoanCleared(userId, loan, { closedAt, silent: false });
  }
}

export async function syncLoanMoments(userId: string, now = new Date()): Promise<void> {
  await inferMissingLoans(userId, now);
  await closeDueLoans(userId, now);
}

export async function loanClearedCards(userId: string): Promise<LoanClearedCard[]> {
  const rows = await db.loanClearedEvent.findMany({ where: { userId, silent: false, dismissedAt: null }, orderBy: { closedAt: "desc" } });
  return rows.map(toCard);
}

export async function freedThrough(userId: string, until: Date): Promise<bigint> {
  const rows = await db.loanClearedEvent.findMany({ where: { userId, closedAt: { lte: until } } });
  return rows.reduce((s, row) => s + row.freedPerMonthMinor, 0n);
}

export async function dismissLoanCleared(userId: string, id: string): Promise<boolean> {
  const result = await db.loanClearedEvent.updateMany({ where: { id, userId, dismissedAt: null }, data: { dismissedAt: new Date() } });
  return result.count > 0;
}
