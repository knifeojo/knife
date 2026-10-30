import { canonicalLender } from "./categorize";

/** A repayment that never arrives is late after this many days past the expected date. */
export const STOPPED_AFTER_DAYS = 45;
const MONTH_DAYS = 30;

export function medianMinor(amounts: bigint[]): bigint | null {
  if (!amounts.length) return null;
  const sorted = [...amounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2n;
}

/** Typical instalment: median of the last three repayments, otherwise the figure on the loan. */
export function freedPerMonth(repayments: bigint[], instalmentMinor: bigint | null): bigint {
  const recent = repayments.slice(-3);
  return medianMinor(recent) ?? instalmentMinor ?? 0n;
}

export function expectedNext(last: Date, gapDays = MONTH_DAYS): Date {
  return new Date(last.getTime() + gapDays * 86_400_000);
}

/** True when `now` is more than 45 days after the repayment that should have followed `last`. */
export function repaymentsStopped(last: Date, now: Date, gapDays = MONTH_DAYS): boolean {
  return now.getTime() > expectedNext(last, gapDays).getTime() + STOPPED_AFTER_DAYS * 86_400_000;
}

export function endedLongAgo(when: Date, now: Date): boolean {
  return now.getTime() - when.getTime() > STOPPED_AFTER_DAYS * 86_400_000;
}

const MERCHANT = /\b(pos|web purchase|purchase at|paystack|flutterwave|shoprite|supermarket|filling station|atm)\b/i;
const LOAN_HINT = /\bloan\b|\brepayment\b|\bremb\b/i;
const PERSON_AFTER_WALLET = /\bto\s+(?:opay|palmpay|moniepoint|kuda|fairmoney|renmoney|carbon|palm ?credit)\b[^A-Za-z]{0,12}([A-Za-z][A-Za-z .'-]{2,48})/i;

export function isMerchantPayment(description: string): boolean {
  return MERCHANT.test(description);
}

function nameTokens(raw: string): string[] {
  return raw.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((t) => t.length > 1);
}

/** A person named in the narration who is not the account owner. Loan words are not a person. */
export function otherPersonTransfer(description: string, userName: string | null | undefined): boolean {
  const match = description.match(PERSON_AFTER_WALLET);
  if (!match) return false;
  const name = match[1].replace(/\s+/g, " ").trim();
  if (LOAN_HINT.test(name) || /^(mfb|loan|repayment|limited|ltd)$/i.test(name)) return false;
  if (name.split(/\s+/).length < 2) return false;
  if (!userName) return true;
  const user = new Set(nameTokens(userName));
  const theirs = nameTokens(name);
  const shared = theirs.filter((t) => user.has(t));
  return shared.length < Math.min(2, theirs.length);
}

export interface RepaymentRow {
  date: Date;
  amountMinor: bigint;
  description: string;
  merchantName: string | null;
  counterparty: string | null;
  category: string;
  type: "DEBIT" | "CREDIT";
}

/** A debt debit that is a repayment to a known lender, not a shop purchase or a transfer to someone else. */
export function lenderOfRepayment(row: RepaymentRow, userName: string | null | undefined): string | undefined {
  if (row.type !== "DEBIT" || row.category !== "Debt") return undefined;
  const text = `${row.merchantName ?? ""} ${row.counterparty ?? ""} ${row.description}`;
  if (isMerchantPayment(text) || otherPersonTransfer(text, userName)) return undefined;
  const lender = canonicalLender(row.merchantName ?? "") ?? canonicalLender(row.counterparty ?? "") ?? canonicalLender(text);
  if (!lender) return undefined;
  const hinted = LOAN_HINT.test(text) || canonicalLender(row.merchantName ?? "") === lender || canonicalLender(row.counterparty ?? "") === lender;
  return hinted ? lender : undefined;
}

export interface InferredLoanDraft {
  lender: string;
  instalmentMinor: bigint;
  totalRepaidMinor: bigint;
  firstPayment: Date;
  lastPayment: Date;
  closed: boolean;
  silent: boolean;
  closedAt: Date | null;
}

export function inferLoanDraft(lender: string, debits: { date: Date; amountMinor: bigint }[], disbursementAfterLast: boolean, now: Date): InferredLoanDraft | null {
  if (debits.length < 3) return null;
  const sorted = [...debits].sort((a, b) => a.date.getTime() - b.date.getTime());
  const last = sorted[sorted.length - 1];
  const stopped = repaymentsStopped(last.date, now) && !disbursementAfterLast;
  const instalment = freedPerMonth(sorted.map((d) => d.amountMinor), null);
  return {
    lender,
    instalmentMinor: instalment,
    totalRepaidMinor: sorted.reduce((s, d) => s + d.amountMinor, 0n),
    firstPayment: sorted[0].date,
    lastPayment: last.date,
    closed: stopped,
    silent: stopped && endedLongAgo(last.date, now),
    closedAt: stopped ? last.date : null,
  };
}

export interface CloseInput {
  source: "manual" | "inferred";
  outstandingMinor: bigint;
  instalmentsPaid: number | null;
  instalmentsTotal: number | null;
  lastRepayment: Date | null;
  disbursementAfterLast: boolean;
  now: Date;
}

/** Why an open loan should close, or null while it is still being repaid. */
export function closeReason(input: CloseInput): "zero" | "final" | "stopped" | null {
  if (input.outstandingMinor === 0n) return "zero";
  const finalInstalment = input.instalmentsTotal !== null && input.instalmentsTotal > 0 && input.instalmentsPaid !== null && input.instalmentsPaid >= input.instalmentsTotal;
  if (finalInstalment) return "final";
  if (input.source !== "inferred") return null;
  if (!input.lastRepayment || input.disbursementAfterLast || !repaymentsStopped(input.lastRepayment, input.now)) return null;
  return "stopped";
}
