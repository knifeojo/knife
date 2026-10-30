import { db } from "@/lib/db";
import { canonicalLender } from "../categorize";
import { parseMoney } from "./money";
import type { AlertMessage } from "./types";

// Lender status texts (outstanding, amount due, due date, instalment N of M, overdue, cleared).
// These update a Loan. They are not payments and must not become transactions.

export interface LoanStatusParse {
  lender?: string;
  outstandingMinor?: bigint;
  amountDueMinor?: bigint;
  nextDueDate?: Date;
  /** Completed instalments. "Instalment 3 of 12" means the 3rd is due, so 2 are paid. */
  instalmentsPaid?: number;
  instalmentTotal?: number;
  cleared: boolean;
  overdue: boolean;
  /** At least 0.8 is enough to update one matching open loan. Below that, Review. */
  confidence: number;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const LOAN = /\bloan\b/i;
const STATUS = /\b(outstanding|amount due|due date|overdue)\b|\binstalments?\s+\d+\s+of\s+\d+\b|\bcleared\b|\bfully (?:paid|repaid)\b/i;
const OUTSTANDING = /(?:outstanding(?:\s+balance)?|balance(?:\s+(?:left|outstanding))?)\s*(?:is|:)?\s*(?:NGN|₦|N)?\s*([\d,]+(?:\.\d{1,2})?)/i;
const AMOUNT_DUE = /amount due\s*(?:is|:)?\s*(?:NGN|₦|N)?\s*([\d,]+(?:\.\d{1,2})?)/i;
const INSTALMENT_PAID = /(\d+)\s+of\s+(\d+)\s+paid/i;
const INSTALMENT = /\binstalments?\s+(\d+)\s+of\s+(\d+)\b/i;
const DUE = /due date\s*(?:is|:)?\s*(\d{1,2}[ /-]?[A-Za-z]{3,9}[ /-]\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i;
const CLEARED = /\bloan (?:has been |is )?cleared\b|\bfully (?:paid|repaid)\b/i;
const OVERDUE = /\boverdue\b/i;

function minor(raw: string | undefined): bigint | undefined {
  if (!raw) return undefined;
  const money = parseMoney(raw);
  return money && money.minor >= 0n ? money.minor : undefined;
}

export function parseLooseDate(raw: string): Date | undefined {
  const text = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return utcDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const named = /^(\d{1,2})[ /-]?([A-Za-z]{3,9})[ /-]?(\d{4})$/.exec(text);
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (month === undefined) return undefined;
    return utcDay(Number(named[3]), month, Number(named[1]));
  }
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (slash) return utcDay(Number(slash[3]), Number(slash[2]) - 1, Number(slash[1]));
  return undefined;
}

function utcDay(year: number, month: number, day: number): Date | undefined {
  if (year < 2000 || year > 2100 || month < 0 || month > 11 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCMonth() !== month || date.getUTCDate() !== day) return undefined;
  return date;
}

/** Null when the text is not a loan-status message (a payment, an OTP, or a loan advert). */
export function parseLoanStatus(sender: string, body: string): LoanStatusParse | null {
  if (!LOAN.test(body) || !STATUS.test(body)) return null;
  const outstandingMinor = minor(body.match(OUTSTANDING)?.[1]);
  const amountDueMinor = minor(body.match(AMOUNT_DUE)?.[1]);
  const paid = body.match(INSTALMENT_PAID);
  const step = paid ? null : body.match(INSTALMENT);
  const instalmentTotal = Number(paid?.[2] ?? step?.[2]);
  const instalmentNumber = Number(paid?.[1] ?? step?.[1]);
  const hasInstalment = Number.isInteger(instalmentTotal) && instalmentTotal > 0 && Number.isInteger(instalmentNumber);
  const nextDueDate = parseLooseDate(body.match(DUE)?.[1] ?? "");
  const cleared = CLEARED.test(body) || outstandingMinor === 0n;
  const overdue = OVERDUE.test(body);
  const strong = outstandingMinor !== undefined || cleared || (hasInstalment && (amountDueMinor !== undefined || nextDueDate !== undefined));
  const lender = canonicalLender(sender) ?? canonicalLender(body);
  return {
    lender,
    outstandingMinor: cleared ? 0n : outstandingMinor,
    amountDueMinor,
    nextDueDate,
    instalmentsPaid: hasInstalment ? (paid ? instalmentNumber : Math.max(0, instalmentNumber - 1)) : undefined,
    instalmentTotal: hasInstalment ? instalmentTotal : undefined,
    cleared,
    overdue,
    confidence: strong ? 0.9 : 0.45,
  };
}

export interface LoanMatch {
  id: string;
  lender: string;
  status: string;
}

/** One open loan for this lender, or none / ambiguous. Closed loans are not updated. */
export function matchOpenLoan(loans: LoanMatch[], parsed: LoanStatusParse, sender: string): { id: string } | "none" | "ambiguous" {
  const names = [parsed.lender, canonicalLender(sender), sender].filter((n): n is string => !!n);
  const hits = loans.filter((loan) => loan.status !== "closed" && names.some((name) => name.toLowerCase() === loan.lender.toLowerCase() || canonicalLender(name) === loan.lender));
  if (hits.length === 1) return { id: hits[0].id };
  if (hits.length === 0) return "none";
  return "ambiguous";
}

export type LoanStatusResult =
  | { status: "loan_update"; applied: true; loanId: string; recorded: boolean }
  | { status: "review"; applied: false; recorded: boolean };

/**
 * Update one matching open loan, or leave the text for Review. Never inserts a transaction.
 * A repeated sourceId is a no-op.
 */
export async function applyLoanStatus(userId: string, msg: AlertMessage, sourceId: string): Promise<LoanStatusResult | null> {
  const parsed = parseLoanStatus(msg.sender, msg.body);
  if (!parsed) return null;
  const prior = await db.loanUpdate.findUnique({ where: { userId_sourceId: { userId, sourceId } } });
  if (prior) {
    return prior.applied && prior.loanId
      ? { status: "loan_update", applied: true, loanId: prior.loanId, recorded: true }
      : { status: "review", applied: false, recorded: true };
  }

  const loans = await db.loan.findMany({ where: { userId }, select: { id: true, lender: true, status: true } });
  const match = matchOpenLoan(loans, parsed, msg.sender);
  const apply = parsed.confidence >= 0.8 && typeof match === "object";
  const status = parsed.cleared || parsed.outstandingMinor === 0n ? "closed" : parsed.overdue ? "overdue" : "open";
  if (apply && typeof match === "object") {
    await db.loan.update({
      where: { id: match.id },
      data: {
        ...(parsed.outstandingMinor !== undefined && { outstandingMinor: parsed.outstandingMinor, balanceAsOf: msg.receivedAt }),
        ...(parsed.nextDueDate && { nextDueDate: parsed.nextDueDate, balanceAsOf: msg.receivedAt }),
        ...(parsed.amountDueMinor !== undefined && { instalmentMinor: parsed.amountDueMinor }),
        ...(parsed.instalmentTotal !== undefined && { instalmentsTotal: parsed.instalmentTotal }),
        ...(parsed.instalmentsPaid !== undefined && { instalmentsPaid: parsed.instalmentsPaid }),
        ...(status === "closed" && { status: "closed", closedAt: msg.receivedAt, outstandingMinor: 0n, balanceAsOf: msg.receivedAt }),
      },
    });
  }
  await db.loanUpdate.create({
    data: {
      userId,
      loanId: apply && typeof match === "object" ? match.id : null,
      sourceId,
      channel: msg.channel,
      sender: msg.sender.slice(0, 200),
      outstandingMinor: parsed.outstandingMinor,
      amountDueMinor: parsed.amountDueMinor,
      nextDueDate: parsed.nextDueDate,
      instalmentNumber: parsed.instalmentsPaid,
      instalmentTotal: parsed.instalmentTotal,
      status,
      confidence: parsed.confidence,
      applied: apply,
      rawText: msg.body.slice(0, 4000),
    },
  });
  return apply && typeof match === "object"
    ? { status: "loan_update", applied: true, loanId: match.id, recorded: false }
    : { status: "review", applied: false, recorded: false };
}
