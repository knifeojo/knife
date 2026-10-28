import { INCOME_CATEGORY, OWN_TRANSFER, categorize, isSelf, sameName } from "../categorize";

export const WALLET_FUND = /debited from \w+ wallet to fund \w+ wallet/i;
export const PAYOUT_PARTNER = /\bdeel\b|pesapeer|\bpesa\b|payoneer/i;

export function isInternalWalletFund(description: string): boolean {
  return WALLET_FUND.test(description);
}

export function looksLikeLandingNarration(description: string): boolean {
  return PAYOUT_PARTNER.test(description);
}

function namedParty(value: string | null | undefined): string | undefined {
  const t = value?.replace(/\s+/g, " ").trim();
  return t && t.length >= 3 ? t : undefined;
}

export function conflictingThirdParty(
  debit: { counterparty?: string | null; description: string },
  credit: { counterparty?: string | null; description: string },
  owners: string[],
): boolean {
  const cc = namedParty(credit.counterparty);
  if (!cc) return false;
  if (isSelf(cc, owners) || PAYOUT_PARTNER.test(cc) || PAYOUT_PARTNER.test(credit.description)) return false;
  const dc = namedParty(debit.counterparty);
  if (dc && sameName(dc, cc)) return false;
  return true;
}

/** Cross-currency pairs that must never be linked, regardless of implied rate. */
export function shouldNeverPair(
  debit: { category: string; description: string; counterparty?: string | null },
  credit: { counterparty?: string | null; description: string },
  owners: string[],
): boolean {
  if (debit.category === "Debt") return true;
  if (isInternalWalletFund(debit.description)) return true;
  return conflictingThirdParty(debit, credit, owners);
}

/**
 * After an FX pair is broken, a payout landing must not fall back to Income
 * just because the narration names Deel / Pesapeer.
 */
export function recategorizeUnpaired(input: { description: string; type: "DEBIT" | "CREDIT" }) {
  const c = categorize({ description: input.description, type: input.type });
  if (input.type === "CREDIT" && c.category === INCOME_CATEGORY && looksLikeLandingNarration(input.description)) {
    return { ...c, category: "Transfers", subcategory: "Unpaired conversion", source: "rule" as const, confidence: Math.min(c.confidence, 0.7) };
  }
  return c;
}

export { OWN_TRANSFER };
