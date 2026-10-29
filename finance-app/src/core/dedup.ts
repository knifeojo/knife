import { createHash } from "node:crypto";
import type { CanonicalTransaction } from "./types";

// Deduplication strategy
// 1. Same source + same source id (e.g. Gmail message id) is always the same observation.
// 2. Exact fingerprint. With a bank reference: institution + account + currency + type + amount + reference
//    (date is excluded because value date and posting date can differ across sources).
//    Without a reference: adds Lagos calendar date, normalized description and balance-after, so two
//    genuine identical purchases on the same day stay separate (their running balances differ).
// 3. Fuzzy match, only across DIFFERENT sources (email vs statement vs open banking): same account,
//    currency, type and amount, dates within 36h, and a matching reference or similar description.
//    Fuzzy matching is never applied within one source, where it would merge real repeat purchases.
// 4. Statement coverage: one statement row and one alert (SMS or email) with the same account,
//    amount and direction, on Lagos days at most one apart, while a statement covers that day.
//    Narration is not required. Two rows of the same amount on that day stay separate, and a
//    repeat a week later does not match.

const NOISE = /\b(TRF|NIP|FIP|POS|WEB|PURCHASE|TRANSFER|TO|FROM|FRM|FOR|REF|NG|LAGOS|LTD|LIMITED|THE|AND|VIA|MOB|MOBILE|APP)\b/g;

export function normalizeDescription(desc: string): string {
  return desc
    .toUpperCase()
    // GTBank SMS payroll credits print "PAYMENTDEEL"; statements/emails often say "DEEL INC".
    .replace(/PAYMENTDEEL/g, "DEEL")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(NOISE, " ")
    .replace(/\b\d{6,}\b/g, " ") // long numeric ids differ between sources
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeReference(ref?: string): string | undefined {
  const r = ref?.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return r && r.length >= 4 ? r : undefined;
}

const LAGOS_OFFSET_MS = 3600_000;
const DAY_MS = 86_400_000;

export function lagosDay(d: Date): string {
  return new Date(d.getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);
}

/** Whole Lagos days since the epoch. Statement value dates and SMS times are both read in WAT (UTC+1). */
export function lagosDayIndex(d: Date): number {
  return Math.floor((d.getTime() + LAGOS_OFFSET_MS) / DAY_MS);
}

export function lagosDayDelta(a: Date, b: Date): number {
  return Math.abs(lagosDayIndex(a) - lagosDayIndex(b));
}

/**
 * True when [date] falls in the account's imported statement span, with one Lagos day of slack
 * so an evening SMS (or a value date stored at UTC midnight) still counts as covered.
 */
export function statementCoversDate(from: Date | null | undefined, to: Date | null | undefined, date: Date): boolean {
  if (!from || !to) return false;
  const day = lagosDayIndex(date);
  return day >= lagosDayIndex(from) - 1 && day <= lagosDayIndex(to) + 1;
}

/**
 * Accounts are keyed on their last three digits: statements often mask everything else
 * ("000XXXX533"), while alerts and other exports show more ("0001234533").
 */
export function accountKey(institution: string, accountLast4?: string): string {
  return `${institution.toUpperCase()}:${accountLast4 ? accountLast4.slice(-3) : "PRIMARY"}`;
}

export function computeFingerprint(tx: CanonicalTransaction): string {
  const ref = normalizeReference(tx.reference);
  const parts = [accountKey(tx.institution, tx.accountLast4), tx.currency, tx.type, tx.amountMinor.toString()];
  if (ref) parts.push(`REF:${ref}`);
  else parts.push(lagosDay(tx.transactionDate), normalizeDescription(tx.description), tx.balanceAfterMinor?.toString() ?? "");
  // No running balance (Deel): identical amount/day rows are still different positions in the file.
  if (tx.balanceAfterMinor === undefined && tx.source === "statement" && !ref) parts.push(`id:${tx.sourceTransactionId}`);
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function tokens(s: string): Set<string> {
  return new Set(normalizeDescription(s).split(" ").filter((t) => t.length > 1));
}

export function descriptionSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  // Overlap coefficient: statement narrations are often a truncated form of the alert narration.
  return inter / Math.min(ta.size, tb.size);
}

/** Minimal shape of an existing ledger row needed for matching. */
export interface LedgerCandidate {
  id: string;
  source: string;
  accountKey: string;
  currency: string;
  type: string;
  amountMinor: bigint;
  transactionDate: Date;
  description: string;
  reference?: string | null;
  balanceAfterMinor?: bigint | null;
  /** Every source already attached, including [source]. */
  sources?: string[];
}

const EMAIL_ALERTS = new Set(["gmail", "imap", "inbound", "fixture"]);

export function alertChannel(source: string): "sms" | "email" | null {
  if (source === "sms") return "sms";
  if (EMAIL_ALERTS.has(source)) return "email";
  return null;
}

export function linkedSources(c: Pick<LedgerCandidate, "source" | "sources">): Set<string> {
  return new Set([c.source, ...(c.sources ?? [])]);
}

const FUZZY_WINDOW_MS = 36 * 3600_000;

export function isFuzzyMatch(tx: CanonicalTransaction, c: LedgerCandidate): boolean {
  // Same account, day, direction, amount AND running balance is the same transaction, even from the
  // same source (overlapping statements). Two genuine identical purchases never leave the same balance.
  if (
    tx.balanceAfterMinor !== undefined && c.balanceAfterMinor != null && tx.balanceAfterMinor === c.balanceAfterMinor &&
    c.accountKey === accountKey(tx.institution, tx.accountLast4) && c.currency === tx.currency &&
    c.type === tx.type && c.amountMinor === tx.amountMinor && lagosDay(c.transactionDate) === lagosDay(tx.transactionDate)
  ) return true;
  if (c.source === tx.source) return false;
  if (c.accountKey !== accountKey(tx.institution, tx.accountLast4) && !c.accountKey.endsWith(":PRIMARY") && tx.accountLast4)
    return false;
  if (c.currency !== tx.currency || c.type !== tx.type || c.amountMinor !== tx.amountMinor) return false;
  if (Math.abs(c.transactionDate.getTime() - tx.transactionDate.getTime()) > FUZZY_WINDOW_MS) return false;

  const r1 = normalizeReference(tx.reference);
  const r2 = normalizeReference(c.reference ?? undefined);
  if (r1 && r2) return r1 === r2 || r1.includes(r2) || r2.includes(r1);
  // One side has a reference that appears in the other's narration
  const d1 = tx.description.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const d2 = c.description.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if ((r1 && d2.includes(r1)) || (r2 && d1.includes(r2))) return true;
  return descriptionSimilarity(tx.description, c.description) >= 0.5;
}

export function findFuzzyMatch(tx: CanonicalTransaction, candidates: LedgerCandidate[]): LedgerCandidate | undefined {
  return candidates.find((c) => isFuzzyMatch(tx, c));
}

/** SMS and email of the same event can be minutes apart even when narration or balance is missing. */
export const ALERT_TIME_WINDOW_MS = 10 * 60_000;

export function isAlertTimeMatch(tx: CanonicalTransaction, c: LedgerCandidate): boolean {
  const left = alertChannel(tx.source);
  const right = alertChannel(c.source);
  if (!left || !right || left === right) return false;
  if (counterpartAlreadyClaimed(tx, c)) return false;
  if (c.currency !== tx.currency || c.type !== tx.type || c.amountMinor !== tx.amountMinor) return false;
  if (c.accountKey !== accountKey(tx.institution, tx.accountLast4) && !c.accountKey.endsWith(":PRIMARY") && tx.accountLast4)
    return false;
  return Math.abs(c.transactionDate.getTime() - tx.transactionDate.getTime()) <= ALERT_TIME_WINDOW_MS;
}

/**
 * Email ↔ SMS: same account, amount and direction, timestamps within about ±10 minutes.
 * Description and running balance are not required. Closest unclaimed row wins.
 */
export function pickAlertTimeMatch(tx: CanonicalTransaction, candidates: LedgerCandidate[]): LedgerCandidate | undefined {
  const channel = alertChannel(tx.source);
  if (!channel) return undefined;
  const hits = candidates.filter((c) => isAlertTimeMatch(tx, c));
  hits.sort((a, b) => {
    const da = Math.abs(a.transactionDate.getTime() - tx.transactionDate.getTime());
    const db = Math.abs(b.transactionDate.getTime() - tx.transactionDate.getTime());
    if (da !== db) return da - db;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return hits[0];
}

const FOREIGN_WALLET = new Set(["USD", "CAD", "GBP", "EUR"]);

/** Non-NGN amounts that differ by one minor unit are the same cents (FX rounding), not a new row. */
export function amountsMatch(a: bigint, b: bigint, currency: string): boolean {
  if (a === b) return true;
  if (!FOREIGN_WALLET.has(currency)) return false;
  const diff = a > b ? a - b : b - a;
  return diff <= 1n;
}

/**
 * A statement re-read is the same row when the account, direction and amount match and the dates
 * are the same Lagos day, or the same instant seen as a UTC date versus a Lagos date.
 * USD and CAD (and the other wallet currencies) are accepted as the same label: a wallet statement
 * is sometimes stored under the wrong code and would otherwise be inserted again.
 */
export function datesAreSameEvent(a: Date, b: Date): boolean {
  if (lagosDay(a) === lagosDay(b)) return true;
  if (lagosDayDelta(a, b) > 1) return false;
  const utcA = a.toISOString().slice(0, 10);
  const utcB = b.toISOString().slice(0, 10);
  return utcA === lagosDay(b) || utcB === lagosDay(a);
}

export function statementReplayMatch(tx: CanonicalTransaction, c: LedgerCandidate): boolean {
  if (tx.source !== "statement" || !linkedSources(c).has("statement")) return false;
  if (c.type !== tx.type) return false;
  if (!amountsMatch(tx.amountMinor, c.amountMinor, tx.currency) && !amountsMatch(tx.amountMinor, c.amountMinor, c.currency)) return false;
  if (!datesAreSameEvent(tx.transactionDate, c.transactionDate)) return false;
  if (c.currency !== tx.currency && !(FOREIGN_WALLET.has(c.currency) && FOREIGN_WALLET.has(tx.currency))) return false;
  const balanceAbsent = tx.balanceAfterMinor === undefined || c.balanceAfterMinor == null;
  if (balanceAbsent && !narrationOrReferenceMatches(tx, c)) return false;
  return true;
}

/** Without a running balance, amount and day are not enough: the words or the reference must agree. */
function narrationOrReferenceMatches(tx: CanonicalTransaction, c: LedgerCandidate): boolean {
  const left = normalizeReference(tx.reference);
  const right = normalizeReference(c.reference ?? undefined);
  if (left && right && (left === right || left.includes(right) || right.includes(left))) return true;
  const a = normalizeDescription(tx.description);
  const b = normalizeDescription(c.description);
  return a.length > 0 && a === b;
}

/**
 * Prefer a row whose running balance matches. Two same-day purchases of the same amount stay apart
 * when their balances differ. A missing balance matches only when it is the only candidate.
 */
export function pickStatementReplay(tx: CanonicalTransaction, candidates: LedgerCandidate[]): LedgerCandidate | undefined {
  const hits = candidates.filter((c) => statementReplayMatch(tx, c));
  if (!hits.length) return undefined;
  const balanced = tx.balanceAfterMinor === undefined
    ? hits.filter((c) => c.balanceAfterMinor == null)
    : hits.filter((c) => c.balanceAfterMinor != null && c.balanceAfterMinor === tx.balanceAfterMinor);
  if (balanced.length === 1) return balanced[0];
  if (balanced.length > 1) {
    return balanced.find((c) => c.currency === tx.currency && lagosDay(c.transactionDate) === lagosDay(tx.transactionDate));
  }
  const missing = hits.filter((c) => tx.balanceAfterMinor === undefined || c.balanceAfterMinor == null);
  return missing.length === 1 ? missing[0] : undefined;
}

function balancesMatch(tx: CanonicalTransaction, c: LedgerCandidate): boolean {
  return tx.balanceAfterMinor !== undefined && c.balanceAfterMinor != null && tx.balanceAfterMinor === c.balanceAfterMinor;
}

/** A statement row may be linked to one statement, and an alert channel may be linked once, unless the running balance says it is the same event. */
export function counterpartAlreadyClaimed(tx: CanonicalTransaction, c: LedgerCandidate): boolean {
  const sources = linkedSources(c);
  if (tx.source === "statement") return sources.has("statement");
  const channel = alertChannel(tx.source);
  if (!channel) return false;
  const hasChannel = channel === "sms" ? sources.has("sms") : [...sources].some((s) => alertChannel(s) === "email");
  if (!hasChannel) return false;
  return !balancesMatch(tx, c);
}

/**
 * Amount-and-day match between a statement row and an alert. Narration is not required.
 * Each side claims at most one counterpart: a candidate already linked to a statement is skipped
 * while importing a statement, and a candidate that already has this alert channel is skipped
 * unless the running balance matches. Among what remains, the closest row wins.
 */
export function pickStatementAmountMatch(
  tx: CanonicalTransaction,
  candidates: LedgerCandidate[],
  covered: boolean,
): LedgerCandidate | undefined {
  if (tx.source !== "statement" && !covered) return undefined;
  const hits = candidates.filter((c) => {
    if (counterpartAlreadyClaimed(tx, c)) return false;
    if (tx.source !== "statement" && !linkedSources(c).has("statement")) return false;
    if (c.currency !== tx.currency || c.type !== tx.type || c.amountMinor !== tx.amountMinor) return false;
    if (c.accountKey !== accountKey(tx.institution, tx.accountLast4) && !c.accountKey.endsWith(":PRIMARY") && tx.accountLast4) return false;
    return lagosDayDelta(c.transactionDate, tx.transactionDate) <= 1;
  });
  hits.sort((a, b) => {
    const da = Math.abs(a.transactionDate.getTime() - tx.transactionDate.getTime());
    const db = Math.abs(b.transactionDate.getTime() - tx.transactionDate.getTime());
    if (da !== db) return da - db;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return hits[0];
}
