// Money helpers. All arithmetic happens on integer minor units, never floats.

const CURRENCY_ALIASES: Record<string, string> = {
  NGN: "NGN",
  "₦": "NGN",
  N: "NGN",
  USD: "USD",
  $: "USD",
  GBP: "GBP",
  "£": "GBP",
  EUR: "EUR",
  "€": "EUR",
  CAD: "CAD",
  GHS: "GHS",
  "₵": "GHS",
  XOF: "XOF",
  CFA: "XOF",
  KES: "KES",
};

export function normalizeCurrency(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  return CURRENCY_ALIASES[t.toUpperCase()] ?? CURRENCY_ALIASES[t];
}

/** "1,983,611.00" -> 198361100n. Returns null for anything that is not a clean decimal amount. */
export function parseAmountToMinor(raw: string): bigint | null {
  // Some statements print sub-naira amounts without a leading zero (".75").
  const cleaned = raw.replace(/[,\s]/g, "").replace(/^\./, "0.");
  const m = cleaned.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "0").padEnd(2, "0"));
  return whole * 100n + frac;
}

export function minorToNumber(minor: bigint | number | null | undefined): number {
  if (minor === null || minor === undefined) return 0;
  return Number(minor) / 100;
}

const SYMBOLS: Record<string, string> = {
  NGN: "₦",
  USD: "$",
  GBP: "£",
  EUR: "€",
  CAD: "CA$",
  GHS: "₵",
  XOF: "CFA",
  KES: "KSh",
};

export function currencySymbol(currency: string): string {
  return SYMBOLS[currency] ?? `${currency} `;
}

export function formatMoney(minor: bigint | number, currency = "NGN", opts: { compact?: boolean } = {}): string {
  const value = typeof minor === "bigint" ? Number(minor) / 100 : minor / 100;
  const symbol = currencySymbol(currency);
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (opts.compact && abs >= 1_000_000) return `${sign}${symbol}${(abs / 1_000_000).toFixed(2)}M`;
  if (opts.compact && abs >= 10_000) return `${sign}${symbol}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${symbol}${abs.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export interface CurrencyAmount {
  currency: string;
  minor: bigint;
}

/** One line per currency, e.g. "$1,197.60 + ₦50,000.00". */
export function formatMoneyParts(parts: CurrencyAmount[], opts: { compact?: boolean } = {}): string {
  const nonempty = parts.filter((p) => p.minor !== 0n);
  if (!nonempty.length) return formatMoney(0n, parts[0]?.currency ?? "NGN", opts);
  return nonempty.map((p) => formatMoney(p.minor, p.currency, opts)).join(" + ");
}

/**
 * Mixed-currency totals: NGN-converted figure for the headline, originals for hover/detail.
 * A single-currency group is shown in that currency, not converted.
 */
export function formatMixedTotal(
  originals: CurrencyAmount[],
  ngnMinor: bigint,
  opts: { compact?: boolean } = {},
): { display: string; detail: string | null; currency: string } {
  const nonempty = originals.filter((p) => p.minor !== 0n);
  if (nonempty.length === 1) {
    return { display: formatMoney(nonempty[0].minor, nonempty[0].currency, opts), detail: null, currency: nonempty[0].currency };
  }
  if (!nonempty.length) return { display: formatMoney(0n, "NGN", opts), detail: null, currency: "NGN" };
  return {
    display: formatMoney(ngnMinor, "NGN", opts),
    detail: formatMoneyParts(nonempty),
    currency: "NGN",
  };
}
