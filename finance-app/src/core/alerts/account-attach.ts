import { db } from "@/lib/db";
import { extractMaskedLast4 } from "./money";
import { isFeeNarration, signedAmount } from "./types";
import type { CanonicalTransaction, SourceType } from "../types";

export const POSSIBLY_ANOTHER_ACCOUNT = "possibly another account";
export const HOLD_LAST4 = "last-4";
export const HOLD_BALANCE = "balance";
export type HoldReason = typeof HOLD_LAST4 | typeof HOLD_BALANCE;

const EMAIL_SOURCES = new Set<SourceType>(["gmail", "imap", "inbound", "fixture"]);
/** Neighbours farther than this are not a reliable chain. */
const NEARBY_MS = 36 * 3600_000;
/** Same-minute ordering (SMS vs email vs statement) is not a contradiction. */
const SAME_MINUTE_MS = 60_000;
/** ₦1 of rounding; fee/VAT rows are skipped entirely rather than tolerated. */
const BALANCE_TOLERANCE = 100n;

export function isEmailAlertSource(source: SourceType): boolean {
  return EMAIL_SOURCES.has(source);
}

export function isPossiblyAnotherAccount(reason: string): boolean {
  return reason === POSSIBLY_ANOTHER_ACCOUNT || reason.startsWith(`${POSSIBLY_ANOTHER_ACCOUNT}:`);
}

export function heldReasonOf(reason: string): HoldReason | undefined {
  if (reason.endsWith(`:${HOLD_LAST4}`)) return HOLD_LAST4;
  if (reason.endsWith(`:${HOLD_BALANCE}`)) return HOLD_BALANCE;
  return undefined;
}

export function heldReasonTag(reason: HoldReason): string {
  return `${POSSIBLY_ANOTHER_ACCOUNT}:${reason}`;
}

const OWN_ACCT =
  /(?:acct|account(?:\s*(?:number|no\.?))?|a\/c)\s*[:.\s#*-]+(?:\*+|•+|●+)?[\s-]*(\d{3,4})\b/i;
const YOUR_ACCT = /\byour\s+account\b[^\d*]{0,24}(?:\*+|•+|●+)?[\s-]*(\d{3,4})\b/i;

/**
 * Last-4 of the holder's account when narration names it ("Acct:******2468").
 * A counterparty mask in "TRANSFER TO ******7643" is ignored.
 */
export function extractNarrationAccountLast4(desc: string | undefined): string | undefined {
  if (!desc) return undefined;
  const labelled = desc.match(OWN_ACCT) ?? desc.match(YOUR_ACCT);
  return labelled ? labelled[1].slice(-4) : undefined;
}

export function shownAccountLast4s(tx: { accountLast4?: string; description: string }): string[] {
  const out: string[] = [];
  const add = (raw?: string) => {
    if (!raw) return;
    const n = raw.replace(/\D/g, "");
    if (n.length < 3) return;
    const digits = n.slice(-4);
    if (!out.includes(digits)) out.push(digits);
  };
  add(tx.accountLast4);
  add(extractNarrationAccountLast4(tx.description));
  add(extractMaskedLast4(tx.accountLast4));
  return out;
}

export function last4MatchesMasked(digits: string, maskedAccountNumber: string): boolean {
  const d = maskedAccountNumber.replace(/\D/g, "");
  return !!d && (d.endsWith(digits) || digits.endsWith(d));
}

function withinTolerance(a: bigint, b: bigint): boolean {
  const gap = a > b ? a - b : b - a;
  return gap <= BALANCE_TOLERANCE;
}

type ChainRow = {
  transactionDate: Date;
  type: string;
  amountMinor: bigint;
  balanceAfterMinor: bigint | null;
  description: string;
};

function isUsableBalanceRow(row: ChainRow): boolean {
  return row.balanceAfterMinor != null && !isFeeNarration(row.description);
}

function chainIncomplete(rows: ChainRow[], from: Date, to: Date): boolean {
  const start = Math.min(from.getTime(), to.getTime());
  const end = Math.max(from.getTime(), to.getTime());
  return rows.some((row) => {
    const t = row.transactionDate.getTime();
    if (t <= start || t >= end) return false;
    return row.balanceAfterMinor == null || isFeeNarration(row.description);
  });
}

/**
 * True when we cannot tell, or when the alert continues the nearby running-balance chain.
 * False only when a neighbour that actually has a balance contradicts this one beyond tolerance.
 *
 * Missing SMS/statement balances, interleaved fees/VAT, and same-minute ordering never fail this
 * check. Comparison uses the nearest balance-bearing non-fee row on each side, amount-adjusted.
 */
export async function balanceFitsAccount(
  userId: string,
  accountId: string,
  tx: Pick<CanonicalTransaction, "type" | "amountMinor" | "transactionDate" | "balanceAfterMinor">,
): Promise<boolean> {
  if (tx.balanceAfterMinor === undefined) return true;
  const nearby = await db.transaction.findMany({
    where: {
      userId,
      accountId,
      transactionDate: {
        gte: new Date(tx.transactionDate.getTime() - NEARBY_MS),
        lte: new Date(tx.transactionDate.getTime() + NEARBY_MS),
      },
    },
    orderBy: [{ transactionDate: "asc" }, { id: "asc" }],
    select: { transactionDate: true, type: true, amountMinor: true, balanceAfterMinor: true, description: true },
  });
  if (!nearby.length) return true;

  const t = tx.transactionDate.getTime();
  const usable = nearby.filter(isUsableBalanceRow);
  const earlier = usable.filter((row) => row.transactionDate.getTime() < t - SAME_MINUTE_MS);
  const later = usable.filter((row) => row.transactionDate.getTime() > t + SAME_MINUTE_MS);
  const before = earlier.at(-1);
  const after = later[0];

  const sameEvent = usable.some(
    (row) =>
      Math.abs(row.transactionDate.getTime() - t) <= SAME_MINUTE_MS &&
      row.amountMinor === tx.amountMinor &&
      row.type === tx.type &&
      row.balanceAfterMinor === tx.balanceAfterMinor,
  );
  if (sameEvent) return true;
  if (!before && !after) return true;

  const checks: boolean[] = [];
  if (before?.balanceAfterMinor != null && !chainIncomplete(nearby, before.transactionDate, tx.transactionDate)) {
    const expected = before.balanceAfterMinor + signedAmount(tx.type, tx.amountMinor);
    checks.push(withinTolerance(expected, tx.balanceAfterMinor));
  }
  if (after?.balanceAfterMinor != null && !chainIncomplete(nearby, tx.transactionDate, after.transactionDate)) {
    const expectedAfter = tx.balanceAfterMinor + signedAmount(after.type as "DEBIT" | "CREDIT", after.amountMinor);
    checks.push(withinTolerance(expectedAfter, after.balanceAfterMinor));
  }
  if (!checks.length) return true;
  return checks.some(Boolean);
}

export interface HeldAlertPayload {
  kind: "held_alert";
  heldReason: HoldReason;
  tx: {
    institution: string;
    type: "DEBIT" | "CREDIT";
    amountMinor: string;
    currency: string;
    transactionDate: string;
    description: string;
    reference?: string;
    balanceAfterMinor?: string;
    accountLast4?: string;
    source: SourceType;
    sourceTransactionId: string;
    confidence: number;
  };
}

export function serializeHeldAlert(tx: CanonicalTransaction, heldReason: HoldReason): string {
  const payload: HeldAlertPayload = {
    kind: "held_alert",
    heldReason,
    tx: {
      institution: tx.institution,
      type: tx.type,
      amountMinor: tx.amountMinor.toString(),
      currency: tx.currency,
      transactionDate: tx.transactionDate.toISOString(),
      description: tx.description,
      reference: tx.reference,
      balanceAfterMinor: tx.balanceAfterMinor?.toString(),
      accountLast4: tx.accountLast4,
      source: tx.source,
      sourceTransactionId: tx.sourceTransactionId,
      confidence: tx.confidence,
    },
  };
  return JSON.stringify(payload);
}

export function parseHeldAlert(raw: string): HeldAlertPayload | undefined {
  const text = raw.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<HeldAlertPayload>;
    if (parsed.kind !== "held_alert" || !parsed.tx?.institution || !parsed.tx.amountMinor) return undefined;
    if (parsed.heldReason !== HOLD_LAST4 && parsed.heldReason !== HOLD_BALANCE) return undefined;
    return parsed as HeldAlertPayload;
  } catch {
    return undefined;
  }
}

export function heldAlertPreview(raw: string): string {
  const held = parseHeldAlert(raw);
  return held?.tx.description ?? raw;
}

export function canonicalFromHeld(payload: HeldAlertPayload): CanonicalTransaction {
  const { tx } = payload;
  return {
    institution: tx.institution,
    type: tx.type,
    amountMinor: BigInt(tx.amountMinor),
    currency: tx.currency,
    transactionDate: new Date(tx.transactionDate),
    description: tx.description,
    reference: tx.reference,
    balanceAfterMinor: tx.balanceAfterMinor != null ? BigInt(tx.balanceAfterMinor) : undefined,
    accountLast4: tx.accountLast4,
    source: tx.source,
    sourceTransactionId: tx.sourceTransactionId,
    confidence: tx.confidence,
  };
}

/** Open held-alert counts by sub-reason. Labels only; no amounts or account numbers. */
export async function heldReasonCounts(userId?: string): Promise<{ reason: HoldReason; count: number }[]> {
  const rows = await db.unparsedAlert.findMany({
    where: { status: "open", reason: { startsWith: POSSIBLY_ANOTHER_ACCOUNT }, ...(userId ? { userId } : {}) },
    select: { reason: true },
  });
  const counts: Record<HoldReason, number> = { [HOLD_LAST4]: 0, [HOLD_BALANCE]: 0 };
  for (const row of rows) {
    const reason = heldReasonOf(row.reason);
    if (reason) counts[reason]++;
  }
  return (Object.entries(counts) as [HoldReason, number][]).map(([reason, count]) => ({ reason, count }));
}

export function formatHeldReasonCounts(counts: { reason: HoldReason; count: number }[]): string {
  const lines = counts.filter((c) => c.count > 0).map((c) => `${c.reason}\t${c.count}`);
  if (!lines.length) return "Held reasons (open): none";
  return `Held reasons (open):\n${lines.join("\n")}`;
}
