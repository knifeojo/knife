import { normalizeCurrency, parseAmountToMinor } from "@/lib/money";
import { parseBankDate } from "../parsers/text";
import type { TransactionType } from "../types";

export const MONEY_RE = /(NGN|USD|GBP|EUR|₦|\$|£|€)?\s*([\d,]+(?:\.\d{1,2})?)\s*(NGN|USD|GBP|EUR)?/i;

export function parseMoney(raw: string | undefined): { minor: bigint; currency?: string } | undefined {
  if (!raw) return undefined;
  const m = raw.match(MONEY_RE);
  if (!m) return undefined;
  const minor = parseAmountToMinor(m[2]);
  if (minor === null) return undefined;
  return { minor, currency: normalizeCurrency(m[1] ?? m[3]) };
}

const STAR_MASK = /(?:\*+|•{2,}|●{2,})[\s-]*(\d{3,4})\b/;
const STAR_PREFIXED = /\b\d{2}(?:\*+|•{2,}|●{2,})(\d{3,4})\b/;
const AMOUNT_HINT = /(?:NGN|USD|GBP|EUR|₦|\$|£|€)\s*[\d,]+|\b[\d,]+\.\d{2}\b/;

function starMaskLast4(raw: string): string | undefined {
  const m = raw.match(STAR_MASK) ?? raw.match(STAR_PREFIXED);
  return m ? m[1].slice(-4) : undefined;
}

export function hasMaskedAccount(raw: string): boolean {
  return STAR_MASK.test(raw) || STAR_PREFIXED.test(raw);
}

/** True when the string is a money amount and does not also carry a masked account. */
export function looksLikeAmount(raw: string): boolean {
  return AMOUNT_HINT.test(raw) && !starMaskLast4(raw);
}

/**
 * Last 4 of a masked account (`******1234`, `01******1234`). Never taken from a
 * transaction amount: NGN 76,430.00 must not become account ending 7643.
 */
export function extractMaskedLast4(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const starred = starMaskLast4(raw);
  if (starred) return starred;
  if (AMOUNT_HINT.test(raw)) return undefined;
  const labelled = raw.match(/(?:acct|account(?:\s*(?:number|no\.?))?|a\/c)\s*[:.\s#*-]+(\d{3,4})\b/i);
  if (labelled) return labelled[1];
  return undefined;
}

export function lastDigits(raw: string | undefined, min = 3): string | undefined {
  if (!raw) return undefined;
  if (looksLikeAmount(raw)) return starMaskLast4(raw);
  const digits = raw.replace(/[^0-9]/g, "");
  return digits.length >= min ? digits.slice(-Math.min(4, digits.length)) : undefined;
}

export function detectDirection(raw: string): TransactionType | undefined {
  const t = raw.toLowerCase();
  if (/\b(debit|debited|money out|you have spent|\bdr\b)\b/.test(t) && !/\b(credit|credited|money in|has arrived|\bcr\b)\b/.test(t)) return "DEBIT";
  if (/\b(credit|credited|money in|has arrived|\bcr\b)\b/.test(t) && !/\b(debit|debited|money out|you have spent|\bdr\b)\b/.test(t)) return "CREDIT";
  if (/\bdr\b/.test(raw) && !/\bcr\b/i.test(raw)) return "DEBIT";
  if (/\bcr\b/i.test(raw) && !/\bdr\b/i.test(raw)) return "CREDIT";
  return undefined;
}

export function parseAlertDate(raw: string | undefined, timeRaw?: string, fallback?: Date): Date {
  return parseBankDate(raw, timeRaw) ?? fallback ?? new Date();
}

export function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Sterling merchant lines pad a country code (IE, US) with runs of spaces. */
export function normalizeMerchant(raw: string): string {
  return collapseSpaces(raw).replace(/\s+([A-Z]{2})$/, " $1");
}

export function trimDesc(raw: string): string {
  return collapseSpaces(raw.replace(/^[\s.-]+/, "").replace(/[\s.]+$/, ""));
}
