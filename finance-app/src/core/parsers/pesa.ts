import { createHash } from "node:crypto";
import { parseAmountToMinor } from "@/lib/money";
import type { CanonicalTransaction, TransactionType } from "../types";
import type { StatementParseResult } from "../statements";
import { parseBankDate } from "./text";

// Pesa wallet PDFs are not a stable column table: the date wraps ("Oct 25," / "2025"),
// the narration wraps, and a parenthetical amount is a debit. Parsed from the text layer.

const MONTH = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const CCY = "CAD|GBP|USD|EUR|NGN|GHS|KES";

export function looksLikePesa(text: string): boolean {
  return /account statement/i.test(text) && /wallet\s*:/i.test(text) && /transaction\s+details/i.test(text);
}

function joinWrappedDates(text: string): string {
  return text.replace(new RegExp(`((?:${MONTH})\\.?)\\s+(\\d{1,2}),[ \\t]*\\r?\\n\\s*(\\d{4})\\b`, "gi"), "$1 $2, $3");
}

/** "Date Issued" / "Period: Oct 20, 2025 - Oct 20, 2026" are not transactions. */
function isMetaDate(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 32), index);
  return /period\s*:?\s*$|issued\s*:?\s*$|\bfrom\s*$|\bto\s*$|-\s*$/i.test(before);
}

function holderOf(preamble: string): string | undefined {
  const m = preamble.match(/account statement\s*([\s\S]*?)(?:\bemail\s*:|\bdate issued\b|\bperiod\s*:|\bwallet\s*:|$)/i);
  if (!m) return undefined;
  const parts = m[1].replace(/[^A-Za-z\s'-]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter((p) => p.length >= 2);
  return parts.length >= 2 ? parts.join(" ") : undefined;
}

function last4(wallet: string | undefined): string | undefined {
  const digits = wallet?.replace(/\D/g, "") ?? "";
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

/**
 * USD unless the wallet id is a country prefix plus a digit ("CA00…" is the CAD wallet,
 * "CAOO…" is not) or the preamble names a currency.
 */
export function pesaCurrency(preamble: string, wallet?: string): string {
  const explicit = preamble.match(/\b(USD|CAD|GBP|EUR|NGN)\b/i)?.[1]?.toUpperCase();
  if (explicit) return explicit;
  if (wallet && /^CA\d/i.test(wallet)) return "CAD";
  if (wallet && /^GB\d/i.test(wallet)) return "GBP";
  if (wallet && /^EU\d/i.test(wallet)) return "EUR";
  if (wallet && /^NG\d/i.test(wallet)) return "NGN";
  if (wallet && /^US\d/i.test(wallet)) return "USD";
  return "USD";
}

interface Tok { start: number; end: number; minor: bigint; paren: boolean; currency?: string }

const TOKEN = new RegExp(
  `\\(\\s*(\\d{1,3}(?:,\\d{3})*|\\d+)\\.(\\d{2})(?!\\d)(?:\\s*(${CCY}))?\\s*\\)|(?<![\\d.(])(\\d{1,3}(?:,\\d{3})*|\\d+)\\.(\\d{2})(?!\\d)(?:\\s*(${CCY}))?`,
  "gi",
);

function tokensIn(flat: string): Tok[] {
  const out: Tok[] = [];
  for (const m of flat.matchAll(TOKEN)) {
    const paren = m[1] !== undefined;
    const whole = (paren ? m[1] : m[4]).replace(/,/g, "");
    const frac = paren ? m[2] : m[5];
    const currency = (paren ? m[3] : m[6])?.toUpperCase();
    const minor = parseAmountToMinor(`${whole}.${frac}`);
    if (minor === null) continue;
    out.push({ start: m.index, end: m.index + m[0].length, minor, paren, currency });
  }
  return out;
}

function parseTail(raw: string): { description: string; type: TransactionType; amount: bigint; balance: bigint } | { error: string } {
  const flat = raw
    .replace(/date\s+transaction\s+details\s+amount[\s$()]*balance[\s$()]*/gi, " ")
    .replace(/page\s+\d+\s+of\s+\d+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return { error: "No debit or credit amount" };
  // Numbers with a currency code ("5.00 CAD", "(2.70 GBP)") belong to the narration.
  const untagged = tokensIn(flat).filter((t) => !t.currency);
  if (untagged.length < 2) return { error: "No debit or credit amount" };
  const balance = untagged[untagged.length - 1];
  const amount = untagged[untagged.length - 2];
  if (balance.paren) return { error: "Unreadable amount" };
  const cuts = [amount, balance].sort((a, b) => a.start - b.start);
  let desc = "";
  let cursor = 0;
  for (const c of cuts) {
    desc += flat.slice(cursor, c.start);
    cursor = c.end;
  }
  desc += flat.slice(cursor);
  desc = desc.replace(/\s+/g, " ").trim();
  return { description: desc, type: amount.paren ? "DEBIT" : "CREDIT", amount: amount.minor, balance: balance.minor };
}

export function parsePesaStatement(text: string): { result: StatementParseResult; currency: string } | null {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!looksLikePesa(normalized)) return null;
  const cut = normalized.search(/transaction\s+details/i);
  const preamble = cut >= 0 ? normalized.slice(0, cut) : normalized;
  const table = joinWrappedDates(cut >= 0 ? normalized.slice(cut) : normalized);
  const wallet = preamble.match(/wallet\s*:\s*([A-Za-z0-9]+)/i)?.[1];
  const currency = pesaCurrency(preamble, wallet);
  const holder = holderOf(preamble);
  const accountLast4 = last4(wallet);

  const dateRe = new RegExp(`(?<![A-Za-z])(${MONTH})\\.?\\s+(\\d{1,2}),\\s*(\\d{4})\\b`, "gi");
  const dates: { index: number; end: number; label: string }[] = [];
  for (const m of table.matchAll(dateRe)) {
    if (isMetaDate(table, m.index)) continue;
    dates.push({ index: m.index, end: m.index + m[0].length, label: `${m[1]} ${m[2]}, ${m[3]}` });
  }

  const errors: StatementParseResult["errors"] = [];
  const transactions: CanonicalTransaction[] = [];
  const seen = new Map<string, number>();
  if (!dates.length) {
    errors.push({ row: 0, reason: "Could not find any dated transactions in this Pesa statement." });
  }

  dates.forEach((d, i) => {
    const row = i + 1;
    const chunk = table.slice(d.end, dates[i + 1]?.index ?? table.length);
    const raw = chunk.replace(/\s+/g, " ").trim().slice(0, 300);
    const date = parseBankDate(d.label);
    if (!date) {
      errors.push({ row, reason: "Unreadable date", raw });
      return;
    }
    const tail = parseTail(chunk);
    if ("error" in tail) {
      errors.push({ row, reason: tail.error, raw });
      return;
    }
    const description = (tail.description || "Pesa transaction").slice(0, 280);
    const key = ["Pesa", accountLast4 ?? "", date.toISOString().slice(0, 10), description, tail.type, tail.amount.toString(), tail.balance.toString()].join("|");
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const sourceTransactionId = createHash("sha256").update(`${key}#${n}`).digest("hex").slice(0, 32);
    transactions.push({
      institution: "Pesa",
      source: "statement",
      sourceTransactionId,
      type: tail.type,
      amountMinor: tail.amount,
      currency,
      transactionDate: date,
      description,
      balanceAfterMinor: tail.balance,
      accountLast4,
      accountHolder: holder,
      confidence: 1,
    });
  });

  return {
    currency,
    result: { transactions, errors, accountLast4, rowsRead: dates.length, holder },
  };
}
