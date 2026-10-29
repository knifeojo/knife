import { db } from "@/lib/db";
import { extractMaskedLast4 } from "./money";
import { signedAmount } from "./types";
import type { CanonicalTransaction, SourceType } from "../types";

export const POSSIBLY_ANOTHER_ACCOUNT = "possibly another account";

const EMAIL_SOURCES = new Set<SourceType>(["gmail", "imap", "inbound", "fixture"]);
const NEARBY_MS = 36 * 3600_000;

export function isEmailAlertSource(source: SourceType): boolean {
  return EMAIL_SOURCES.has(source);
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

/**
 * True when we cannot tell, or when the alert continues the nearby running-balance chain.
 * False when a nearby row exists and this balance would not follow from it (or into the next).
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
      balanceAfterMinor: { not: null },
      transactionDate: {
        gte: new Date(tx.transactionDate.getTime() - NEARBY_MS),
        lte: new Date(tx.transactionDate.getTime() + NEARBY_MS),
      },
    },
    orderBy: [{ transactionDate: "asc" }, { id: "asc" }],
  });
  if (!nearby.length) return true;

  const before = [...nearby].filter((row) => row.transactionDate.getTime() <= tx.transactionDate.getTime()).at(-1);
  const after = nearby.find((row) => row.transactionDate.getTime() > tx.transactionDate.getTime());

  if (before?.balanceAfterMinor != null) {
    if (before.amountMinor === tx.amountMinor && before.type === tx.type && before.balanceAfterMinor === tx.balanceAfterMinor)
      return true;
    const expected = before.balanceAfterMinor + signedAmount(tx.type, tx.amountMinor);
    if (expected === tx.balanceAfterMinor) return true;
  }
  if (after?.balanceAfterMinor != null) {
    const expectedAfter = tx.balanceAfterMinor + signedAmount(after.type as "DEBIT" | "CREDIT", after.amountMinor);
    if (expectedAfter === after.balanceAfterMinor) return true;
  }
  return false;
}
