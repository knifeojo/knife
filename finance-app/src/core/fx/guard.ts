/** Hard naira-per-unit bands so a poisoned bootstrap median cannot bless a nonsense pair. */
export const SANITY_BAND: Record<string, readonly [number, number]> = {
  USD: [500, 3000],
  CAD: [400, 2500],
  GBP: [700, 3500],
  EUR: [600, 3200],
};

/** Relative band vs a live market quote. */
export const MARKET_OUTLIER = 0.10;
/** Relative band vs a median or bundled seed when no live market quote exists. */
export const MEDIAN_OUTLIER = 0.15;
/** Existing pairs this close to market are left linked, even if the sender looks unfamiliar. */
export const KEEP_PAIRED = 0.08;
/** @deprecated Use MARKET_OUTLIER; kept so older imports keep compiling. */
export const OUTLIER_TOLERANCE = MARKET_OUTLIER;

export type RateKind = "market" | "median";

export function inSanityBand(rate: number, currency: string): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  const band = SANITY_BAND[currency];
  if (!band) return rate >= 50 && rate <= 10_000;
  return rate >= band[0] && rate <= band[1];
}

export function offBy(rate: number, ref: number): number {
  return Math.abs(rate - ref) / ref;
}

export function isOutlierRate(rate: number, reference: number | undefined, tolerance = MARKET_OUTLIER): boolean {
  if (reference === undefined || !Number.isFinite(reference) || reference <= 0) return false;
  if (!Number.isFinite(rate) || rate <= 0) return true;
  return offBy(rate, reference) > tolerance;
}

export function nearMarket(rate: number, market: number | undefined): boolean {
  if (market === undefined || !Number.isFinite(market) || market <= 0) return false;
  return offBy(rate, market) <= KEEP_PAIRED;
}

/** Relative guard (10% vs market, 15% vs median/seed) plus the hard sanity band. */
export function isUnusableRate(
  rate: number,
  currency: string,
  reference?: number,
  kind: RateKind = "median",
): boolean {
  if (!inSanityBand(rate, currency)) return true;
  return isOutlierRate(rate, reference, kind === "market" ? MARKET_OUTLIER : MEDIAN_OUTLIER);
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
  if (cadReference && cadReference > 0 && offBy(rate, cadReference) <= MEDIAN_OUTLIER) {
    return !usdReference || offBy(rate, usdReference) > MARKET_OUTLIER;
  }
  if (usdReference && usdReference > 0 && offBy(rate, usdReference) > MARKET_OUTLIER) {
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
