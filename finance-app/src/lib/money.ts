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
};

export function normalizeCurrency(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return CURRENCY_ALIASES[raw.trim().toUpperCase()] ?? CURRENCY_ALIASES[raw.trim()];
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

const SYMBOLS: Record<string, string> = { NGN: "₦", USD: "$", GBP: "£", EUR: "€", CAD: "CA$" };

export function formatMoney(minor: bigint | number, currency = "NGN", opts: { compact?: boolean } = {}): string {
  const value = typeof minor === "bigint" ? Number(minor) / 100 : minor / 100;
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (opts.compact && abs >= 1_000_000) return `${sign}${symbol}${(abs / 1_000_000).toFixed(2)}M`;
  if (opts.compact && abs >= 10_000) return `${sign}${symbol}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${symbol}${abs.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
