import { INCOME_CATEGORY, OWN_TRANSFER, categorize, isSelf, lenderMerchant, sameName } from "../categorize";
import { BANKS } from "../statements";

export const WALLET_FUND = /debited from \w+ wallet to fund \w+ wallet/i;
/** Deel even when a prefix is glued on: PAYMENTDEEL INC, NIPDEEL. */
export const DEEL_GLUED = /deel/i;
/** Rails that deliver the user's own payouts — not third-party senders. */
export const PAYOUT_RAIL = /\bkora\b|d\s*-?\s*local|\bdlocal\b|moniepoint|monie\s*mfb|\bvfd\b|\bvbank\b/i;
export const PAYOUT_PARTNER = /deel|pesapeer|\bpesa\b|payoneer|kora|d\s*-?\s*local|\bdlocal\b|moniepoint|monie\s*mfb|\bvfd\b|\bvbank\b/i;

export function isInternalWalletFund(description: string): boolean {
  return WALLET_FUND.test(description);
}

export function looksLikeDeel(text: string): boolean {
  return DEEL_GLUED.test(text);
}

export function looksLikePayoutRail(text: string): boolean {
  return PAYOUT_RAIL.test(text);
}

export function looksLikeLandingNarration(description: string): boolean {
  return PAYOUT_PARTNER.test(description);
}

export function isOwnBankName(value: string | null | undefined): boolean {
  if (!value) return false;
  return BANKS.some(([re]) => re.test(value));
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
  const hay = `${cc} ${credit.description}`;
  if (isSelf(cc, owners) || looksLikeLandingNarration(hay) || isOwnBankName(cc) || isOwnBankName(credit.description)) return false;
  const dc = namedParty(debit.counterparty);
  if (dc && sameName(dc, cc)) return false;
  return true;
}

/** Debt repayments and internal wallet-fund lines — never a conversion, even at a sane rate. */
export function hardNeverPair(debit: { category: string; description: string }): boolean {
  return debit.category === "Debt" || isInternalWalletFund(debit.description);
}

/** Cross-currency pairs that must never be linked, regardless of implied rate. */
export function shouldNeverPair(
  debit: { category: string; description: string; counterparty?: string | null },
  credit: { counterparty?: string | null; description: string },
  owners: string[],
): boolean {
  if (hardNeverPair(debit)) return true;
  return conflictingThirdParty(debit, credit, owners);
}

/**
 * After an FX pair is broken, a naira landing must not fall back to Income.
 * Own-name / own-bank → Own transfer; loan providers → Debt / loan proceeds.
 */
export function recategorizeUnpaired(input: {
  description: string;
  type: "DEBIT" | "CREDIT";
  counterparty?: string | null;
  owners?: string[];
}) {
  const hay = `${input.description} ${input.counterparty ?? ""}`;
  const owners = input.owners ?? [];
  if (input.type === "CREDIT") {
    const lender = lenderMerchant(hay) ?? (input.counterparty ? lenderMerchant(input.counterparty) : undefined);
    if (lender) {
      return { category: "Debt", subcategory: "Loan proceeds", merchantName: lender, source: "rule" as const, confidence: 0.9 };
    }
    const ownName = isSelf(input.counterparty ?? undefined, owners);
    const ownBank = isOwnBankName(input.counterparty) || isOwnBankName(input.description);
    if (ownName || ownBank || looksLikeLandingNarration(hay)) {
      return { category: OWN_TRANSFER, subcategory: "Unpaired conversion", source: "rule" as const, confidence: 0.7 };
    }
  }
  const c = categorize({ description: input.description, type: input.type }, [], owners);
  if (input.type === "CREDIT" && c.category === INCOME_CATEGORY && looksLikeLandingNarration(hay)) {
    return { ...c, category: OWN_TRANSFER, subcategory: "Unpaired conversion", source: "rule" as const, confidence: Math.min(c.confidence, 0.7) };
  }
  return c;
}

export { OWN_TRANSFER };
