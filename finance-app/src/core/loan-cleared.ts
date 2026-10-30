import { COMPANY, canonicalLender, extractCounterparty } from "./categorize";

/** A repayment that never arrives is late after this many days past the expected date. */
export const STOPPED_AFTER_DAYS = 45;
/** A loan closed this recently, with no moment yet, still gets "Loan cleared" once. */
export const CLEARED_BACKFILL_DAYS = 14;
/** An inferred loan's expected repayment is late enough to ask if it is paid off. */
export const REVIEW_OVERDUE_DAYS = 7;
/** "No" on that question waits this long before asking again. */
export const REVIEW_SNOOZE_DAYS = 30;
/** The same beneficiary on this many lender debits is the user's own repayment, not a one-off transfer. */
export const REPEAT_SELF_COUNT = 3;
const MONTH_DAYS = 30;
const OWN_TRANSFER = "Own transfer";

export function medianMinor(amounts: bigint[]): bigint | null {
  if (!amounts.length) return null;
  const sorted = [...amounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2n;
}

/**
 * Usual repayment over the whole history. Drop amounts under half or over twice the overall
 * median (a 14k partial, or a 400k payoff, among 70k–150k instalments), then take the median again.
 */
export function typicalInstalment(amounts: bigint[]): bigint | null {
  if (!amounts.length) return null;
  const overall = medianMinor(amounts);
  if (overall === null || overall <= 0n) return null;
  const kept = amounts.filter((amount) => amount * 2n >= overall && amount <= overall * 2n);
  return medianMinor(kept.length ? kept : amounts);
}

/** Latest payment is a payoff when it is at least 2.5× the typical instalment before it. */
export function isLumpSum(amounts: bigint[]): boolean {
  if (amounts.length < 2) return false;
  const typical = typicalInstalment(amounts.slice(0, -1));
  if (typical === null || typical <= 0n) return false;
  return amounts[amounts.length - 1] * 2n >= typical * 5n;
}

/** Freed each month: the robust typical instalment, otherwise the figure stored on the loan. */
export function freedPerMonth(repayments: bigint[], instalmentMinor: bigint | null): bigint {
  return typicalInstalment(repayments) ?? instalmentMinor ?? 0n;
}

/** A payoff that covers a known balance can close at once. Otherwise one cycle of silence (30 days, no extra 7) is enough. */
export function lumpSumSettled(last: Date, now: Date, lumpMinor: bigint | null = null, remainingMinor: bigint | null = null): boolean {
  if (lumpMinor != null && remainingMinor != null && remainingMinor > 0n && lumpMinor >= remainingMinor) return true;
  return now.getTime() >= last.getTime() + MONTH_DAYS * 86_400_000;
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

/** True when `closedAt` falls inside the backfill window ending at `now`. */
export function closedRecently(closedAt: Date | null, now: Date): boolean {
  if (!closedAt) return false;
  return closedAt.getTime() >= now.getTime() - CLEARED_BACKFILL_DAYS * 86_400_000;
}

/** True when `now` is more than 7 days after the repayment that was expected. */
export function repaymentOverdue(expected: Date, now: Date): boolean {
  return now.getTime() > expected.getTime() + REVIEW_OVERDUE_DAYS * 86_400_000;
}

export function reviewSnoozeUntil(now: Date): Date {
  return new Date(now.getTime() + REVIEW_SNOOZE_DAYS * 86_400_000);
}

const MERCHANT = /\b(pos|web purchase|purchase at|paystack|flutterwave|shoprite|supermarket|filling station|atm)\b/i;
const LOAN_HINT = /\bloan\b|\brepayment\b|\bremb\b/i;
const PERSON_AFTER_WALLET = /\bto\s+(?:opay|palmpay|moniepoint|kuda|fairmoney|renmoney|carbon|palm ?credit|branch|aella|quick ?check|okash|easemoni|lendigo|specta|newcredit|sokoloan|zedvance)\b[^A-Za-z]{0,12}([A-Za-z][A-Za-z .'-]{2,48})/i;
const NOT_A_PERSON = /^(mfb|loan|repayment|limited|ltd)$/i;

export function isMerchantPayment(description: string): boolean {
  return MERCHANT.test(description);
}

type NameInput = string | readonly string[] | null | undefined;

function asNames(names: NameInput): string[] {
  if (!names) return [];
  return typeof names === "string" ? [names] : [...names];
}

function words(raw: string): string[] {
  return raw.toLowerCase().replace(/[^a-z]/g, " ").split(/\s+/).filter(Boolean);
}

function nameTokens(raw: string): string[] {
  return words(raw).filter((t) => t.length > 1);
}

function explicitInitial(raw: string): string | null {
  return words(raw).find((w) => w.length === 1) ?? null;
}

function firstToken(raw: string): string | null {
  return nameTokens(raw)[0] ?? null;
}

/**
 * The narration name is this known name: two tokens in common, the shorter name is the
 * longer name's first name, or a surname plus a first initial ("T Nwosu" = "Tunde Nwosu").
 */
export function isOwnName(beneficiary: string, known: string): boolean {
  const a = nameTokens(beneficiary);
  const b = nameTokens(known);
  if (!a.length || !b.length) return false;
  const setB = new Set(b);
  if (a.filter((t) => setB.has(t)).length >= 2) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const longerRaw = a.length <= b.length ? known : beneficiary;
  if (shorter.length === 1 && shorter[0] === firstToken(longerRaw)) return true;
  const initialA = explicitInitial(beneficiary);
  const initialB = explicitInitial(known);
  const explicit = initialA ?? initialB;
  if (!explicit) return false;
  const otherInitial = (initialA ? firstToken(known)?.[0] : firstToken(beneficiary)?.[0]) ?? (initialA ? initialB : initialA);
  if (explicit !== otherInitial) return false;
  const shared = a.filter((t) => setB.has(t));
  return shared.some((t) => t === a[a.length - 1] || t === b[b.length - 1]);
}

/** True only when every known name is a different person. An unknown owner is not excluded. */
export function isClearlySomeoneElse(beneficiary: string, selfNames: NameInput): boolean {
  const known = asNames(selfNames).filter((n) => nameTokens(n).length > 0 || explicitInitial(n));
  if (!known.length) return false;
  return known.every((name) => !isOwnName(beneficiary, name));
}

/** The person named after a lender in "TO <lender> - <name>". Loan words are not a person. */
export function beneficiaryAfterLender(description: string): string | null {
  const match = description.match(PERSON_AFTER_WALLET);
  if (!match) return null;
  const name = match[1].replace(/\s+/g, " ").trim();
  if (!name || LOAN_HINT.test(name) || NOT_A_PERSON.test(name)) return null;
  if (name.split(/\s+/).length < 2) return null;
  return name;
}

/** A person named in the narration who is clearly not the account owner. */
export function otherPersonTransfer(description: string, selfNames: NameInput): boolean {
  const name = beneficiaryAfterLender(description);
  if (!name) return false;
  return isClearlySomeoneElse(name, selfNames);
}

function nameKey(name: string): string {
  return nameTokens(name).slice().sort().join(" ");
}

function looksLikePerson(name: string): boolean {
  if (COMPANY.test(name) || canonicalLender(name)) return false;
  return nameTokens(name).length >= 2 || (nameTokens(name).length === 1 && !!explicitInitial(name));
}

/** Names on own-transfer credits: money arriving from an account in the user's own name. */
export function ownTransferCreditNames(rows: RepaymentRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.type !== "CREDIT" || row.category !== OWN_TRANSFER) continue;
    const extracted = extractCounterparty(row.description, "CREDIT");
    for (const candidate of [row.counterparty, extracted]) {
      if (candidate && looksLikePerson(candidate)) out.push(candidate);
    }
  }
  return out;
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

interface LenderCandidate {
  lender: string;
  name: string | null;
  other: boolean;
}

function lenderCandidate(row: RepaymentRow, selfNames: NameInput): LenderCandidate | null {
  if (row.type !== "DEBIT" || row.category !== "Debt") return null;
  const text = `${row.merchantName ?? ""} ${row.counterparty ?? ""} ${row.description}`;
  if (isMerchantPayment(text)) return null;
  const lender = canonicalLender(row.merchantName ?? "") ?? canonicalLender(row.counterparty ?? "") ?? canonicalLender(text);
  if (!lender) return null;
  const hinted = LOAN_HINT.test(text) || canonicalLender(row.merchantName ?? "") === lender || canonicalLender(row.counterparty ?? "") === lender;
  if (!hinted) return null;
  const name = beneficiaryAfterLender(row.description) ?? beneficiaryAfterLender(text);
  return { lender, name, other: !!name && isClearlySomeoneElse(name, selfNames) };
}

/** A debt debit that is a repayment to a known lender, not a shop purchase or a transfer to someone else. */
export function lenderOfRepayment(row: RepaymentRow, selfNames: NameInput): string | undefined {
  const hit = lenderCandidate(row, selfNames);
  if (!hit || hit.other) return undefined;
  return hit.lender;
}

/**
 * Debt debits grouped by lender. A name that clearly is not the user is left out, unless that
 * same name is on at least three debits to that lender — then it is the user's own repayment.
 */
export function groupLenderRepayments(rows: RepaymentRow[], selfNames: NameInput): Map<string, RepaymentRow[]> {
  const groups = new Map<string, RepaymentRow[]>();
  const held = new Map<string, { lender: string; rows: RepaymentRow[] }>();
  for (const row of rows) {
    const hit = lenderCandidate(row, selfNames);
    if (!hit) continue;
    if (hit.other && hit.name) {
      const key = `${hit.lender}\n${nameKey(hit.name)}`;
      const bucket = held.get(key) ?? { lender: hit.lender, rows: [] };
      bucket.rows.push(row);
      held.set(key, bucket);
      continue;
    }
    const list = groups.get(hit.lender) ?? [];
    list.push(row);
    groups.set(hit.lender, list);
  }
  for (const bucket of held.values()) {
    if (bucket.rows.length < REPEAT_SELF_COUNT) continue;
    const list = groups.get(bucket.lender) ?? [];
    list.push(...bucket.rows);
    groups.set(bucket.lender, list);
  }
  return groups;
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
  closeReason: "lump_sum" | "inactivity" | null;
}

export function inferLoanDraft(lender: string, debits: { date: Date; amountMinor: bigint }[], disbursementAfterLast: boolean, now: Date): InferredLoanDraft | null {
  if (debits.length < 3) return null;
  const sorted = [...debits].sort((a, b) => a.date.getTime() - b.date.getTime());
  const last = sorted[sorted.length - 1];
  const amounts = sorted.map((d) => d.amountMinor);
  const lump = isLumpSum(amounts) && !disbursementAfterLast && lumpSumSettled(last.date, now);
  const stopped = !lump && repaymentsStopped(last.date, now) && !disbursementAfterLast;
  const instalment = freedPerMonth(amounts, null);
  const closed = lump || stopped;
  return {
    lender,
    instalmentMinor: instalment,
    totalRepaidMinor: sorted.reduce((s, d) => s + d.amountMinor, 0n),
    firstPayment: sorted[0].date,
    lastPayment: last.date,
    closed,
    silent: closed && endedLongAgo(last.date, now),
    closedAt: closed ? last.date : null,
    closeReason: lump ? "lump_sum" : stopped ? "inactivity" : null,
  };
}

export interface CloseInput {
  source: "manual" | "inferred";
  outstandingMinor: bigint | null;
  instalmentsPaid: number | null;
  instalmentsTotal: number | null;
  lastRepayment: Date | null;
  /** Latest repayment is at least 2.5× the typical instalment before it. */
  lumpSum: boolean;
  lumpMinor: bigint | null;
  /** Known balance before this payoff. Null when Ledger has not seen one. */
  remainingMinor: bigint | null;
  disbursementAfterLast: boolean;
  now: Date;
}

/** Why an open loan should close, or null while it is still being repaid. */
export function closeReason(input: CloseInput): "zero" | "final" | "lump_sum" | "inactivity" | null {
  if (input.outstandingMinor === 0n) return "zero";
  const finalInstalment = input.instalmentsTotal !== null && input.instalmentsTotal > 0 && input.instalmentsPaid !== null && input.instalmentsPaid >= input.instalmentsTotal;
  if (finalInstalment) return "final";
  if (input.source !== "inferred") return null;
  if (!input.lastRepayment || input.disbursementAfterLast) return null;
  if (input.lumpSum && lumpSumSettled(input.lastRepayment, input.now, input.lumpMinor, input.remainingMinor)) return "lump_sum";
  if (!repaymentsStopped(input.lastRepayment, input.now)) return null;
  return "inactivity";
}
