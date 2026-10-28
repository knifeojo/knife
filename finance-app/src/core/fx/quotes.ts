import { parseAmountToMinor } from "@/lib/money";

/** Street/official naira-per-unit band we will accept as a quoted payout rate. */
const RATE_MIN = 200;
const RATE_MAX = 5_000;

export interface PayoutQuote {
  ngnMinor: bigint;
  rate: number;
}

/**
 * A wallet payout line often states the naira proceeds or the rate
 * ("@ 1550 NGN", "rate: 1,550", "NGN 155,000.00"). Used as a realised rate
 * even before the bank credit is paired.
 */
export function extractPayoutQuote(description: string, foreignMinor: bigint): PayoutQuote | null {
  if (foreignMinor <= 0n) return null;
  const text = description.replace(/\s+/g, " ");

  const rateHits = [
    /(?:@|at(?:\s+rate)?|rate)\s*:?\s*([\d,]+(?:\.\d{1,4})?)\s*(?:NGN|naira|₦)?/i,
    /([\d,]+(?:\.\d{1,4})?)\s*(?:NGN|₦)\s*(?:\/|per)\s*(?:USD|CAD|GBP|EUR|\$|1)/i,
  ];
  for (const re of rateHits) {
    const m = text.match(re);
    if (!m) continue;
    const rate = Number(m[1].replace(/,/g, ""));
    if (!plausibleRate(rate)) continue;
    const ngnMinor = BigInt(Math.round(Number(foreignMinor) * rate));
    if (ngnMinor > 0n) return { ngnMinor, rate };
  }

  const amountHits = [
    /(?:NGN|₦)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /([\d,]+\.\d{2})\s*(?:NGN|naira)\b/i,
  ];
  for (const re of amountHits) {
    const m = text.match(re);
    if (!m) continue;
    const raw = m[1].replace(/,/g, "");
    // 8+ digit integers with no decimal are account numbers, not proceeds.
    if (/^\d{8,}$/.test(raw)) continue;
    const ngnMinor = parseAmountToMinor(m[1]);
    if (!ngnMinor || ngnMinor <= 0n) continue;
    const rate = Number(ngnMinor) / Number(foreignMinor);
    if (!plausibleRate(rate)) continue;
    return { ngnMinor, rate };
  }
  return null;
}

function plausibleRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= RATE_MIN && rate <= RATE_MAX;
}
