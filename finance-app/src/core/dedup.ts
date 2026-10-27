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

export function lagosDay(d: Date): string {
  return new Date(d.getTime() + 3600_000).toISOString().slice(0, 10);
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
