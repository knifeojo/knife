/** Hard naira-per-unit bands so a poisoned bootstrap median cannot bless a nonsense pair. */
export const SANITY_BAND: Record<string, readonly [number, number]> = {
  USD: [500, 3000],
  CAD: [400, 2500],
  GBP: [700, 3500],
  EUR: [600, 3200],
};

export const OUTLIER_TOLERANCE = 0.20;

export function inSanityBand(rate: number, currency: string): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  const band = SANITY_BAND[currency];
  if (!band) return rate >= 50 && rate <= 10_000;
  return rate >= band[0] && rate <= band[1];
}

export function offBy(rate: number, ref: number): number {
  return Math.abs(rate - ref) / ref;
}

export function isOutlierRate(rate: number, reference: number | undefined): boolean {
  if (reference === undefined || !Number.isFinite(reference) || reference <= 0) return false;
  if (!Number.isFinite(rate) || rate <= 0) return true;
  return offBy(rate, reference) > OUTLIER_TOLERANCE;
}

/** Relative ±20% guard plus the hard sanity band. */
export function isUnusableRate(rate: number, currency: string, reference?: number): boolean {
  if (!inSanityBand(rate, currency)) return true;
  return isOutlierRate(rate, reference);
}

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * A USD-labeled implied rate that is far from USD but close to CAD (or ~75% of the USD
 * reference, the usual CAD/USD band) is a CAD wallet leg stored as USD.
 */
export function looksLikeCadNotUsd(rate: number, usdReference?: number, cadReference?: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (cadReference && cadReference > 0 && offBy(rate, cadReference) <= OUTLIER_TOLERANCE) {
    return !usdReference || offBy(rate, usdReference) > OUTLIER_TOLERANCE;
  }
  if (usdReference && usdReference > 0 && offBy(rate, usdReference) > OUTLIER_TOLERANCE) {
    const ratio = rate / usdReference;
    return ratio >= 0.65 && ratio <= 0.85;
  }
  return false;
}

export function monthlyMedian(
  rows: { date: string; currency: string; rate: number }[],
  date: string,
  currency: string,
): number | undefined {
  const month = monthKey(date);
  return median(rows.filter((r) => r.currency === currency && monthKey(r.date) === month).map((r) => r.rate));
}
