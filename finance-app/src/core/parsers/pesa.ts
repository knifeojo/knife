import { createHash } from "node:crypto";
import { parseAmountToMinor } from "@/lib/money";
import type { CanonicalTransaction, TransactionType } from "../types";
import type { StatementParseResult } from "../statements";
import { parseBankDate } from "./text";

// Pesa wallet PDFs are not a stable column table: the date wraps ("Oct 25," / "2025"),
// the narration wraps, and a parenthetical amount is a debit. Parsed from the text layer.
// A row often straddles a page: the repeated table header and footer land in the middle,
// and the date line and the amount/balance columns can be on different pages.

const MONTH = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const CCY = "CAD|GBP|USD|EUR|NGN|GHS|KES";

export function looksLikePesa(text: string): boolean {
  return /account statement/i.test(text) && /wallet\s*:/i.test(text) && /transaction\s+details/i.test(text);
}

/**
 * "Oct 25," / "2025" is one date even when a page header used to sit between them, and even when
 * the narration shares the day line ("Oct 27, Money transfer (\n2025").
 */
function joinWrappedDates(text: string): string {
  const re = new RegExp(
    `(?<![A-Za-z])((?:${MONTH})\\.?)\\s+(\\d{1,2}),(?![ \\t]*\\d{4}\\b)([^\\n]*)\\n(?:[ \\t]*\\n){0,2}[ \\t]*(\\d{4})\\b`,
    "gi",
  );
  return text.replace(re, (_m, mon: string, day: string, rest: string, year: string) => `${mon} ${day}, ${year}${rest}`);
}

/** Repeated table headers and page footers. They are not part of any transaction. */
function stripChrome(text: string): string {
  const stripped = text
    .replace(/date\s+transaction\s+details\s+amount\s*(?:\(\s*\$\s*\))?\s*balance\s*\(\s*\$\s*\)/gi, "\n")
    .replace(/\bpage\s+\d+\s+of\s+\d+\b/gi, "\n")
    .replace(/--\s*\d+\s+of\s+\d+\s*--/gi, "\n");
  return stripped
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^(?:date|amount|balance|transaction details)$/i.test(t)) return false;
      if (/^\(\s*\$\s*\)$/.test(t)) return false;
      if (/^(?:amount|balance)\s*\(\s*\$\s*\)$/i.test(t)) return false;
      if (/^continued(?:\s+on\s+next\s+page)?\.?$/i.test(t)) return false;
      if (/transaction\s+details\s+amount/i.test(t) && !/\d/.test(t)) return false;
      if (/^date\s+transaction\s+details\b/i.test(t) && !/\d/.test(t)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
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
    // "$50.00" inside "Payout of $50.00 was … reversed" is narration, not a column.
    if (/\$\s*$/.test(flat.slice(Math.max(0, m.index - 3), m.index))) continue;
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

function columnTokens(flat: string): Tok[] {
  return tokensIn(flat).filter((t) => !t.currency);
}

function flatten(raw: string): string {
  return raw
    .replace(/date\s+transaction\s+details\s+amount[\s$()]*balance[\s$()]*/gi, " ")
    .replace(/page\s+\d+\s+of\s+\d+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Running balance agrees with the previous row (1 minor unit of FX rounding is allowed). */
function continues(prev: bigint, type: TransactionType, amount: bigint, balance: bigint): boolean {
  const expected = type === "CREDIT" ? prev + amount : prev - amount;
  const diff = expected > balance ? expected - balance : balance - expected;
  return diff <= 1n;
}

function interpret(tokens: Tok[]): { amount: Tok; balance: Tok } | { error: string } {
  if (tokens.length < 2) return { error: "No debit or credit amount" };
  const last = tokens[tokens.length - 1];
  // Normal column order: amount, then balance. A parenthetical balance is the next row's debit glued on.
  if (!last.paren) return { amount: tokens[tokens.length - 2], balance: last };
  // Page break put the balance column on the earlier page and the (debit) on the next.
  const plains = tokens.filter((t) => !t.paren);
  if (plains.length === 1) return { amount: last, balance: plains[0] };
  return { error: "Unreadable amount" };
}

function tidyDescription(desc: string): string {
  return desc.replace(/(?:\s*\()+\s*$/g, "").replace(/\s+/g, " ").trim();
}

function parseTail(raw: string, prevBalance?: bigint): { description: string; type: TransactionType; amount: bigint; balance: bigint } | { error: string } {
  const flat = flatten(raw);
  if (!flat) return { error: "No debit or credit amount" };
  const untagged = columnTokens(flat);
  const picked = interpret(untagged);
  if ("error" in picked) return picked;
  const type: TransactionType = picked.amount.paren ? "DEBIT" : "CREDIT";
  // Only the out-of-order reading is checked. A normal "amount then balance" row is kept even when
  // the statement's balance resets (a new period), which is what the synthetic wallet fixture does.
  const scrambled = picked.amount === untagged[untagged.length - 1] && picked.amount.paren;
  if (scrambled && prevBalance !== undefined && !continues(prevBalance, type, picked.amount.minor, picked.balance.minor)) {
    return { error: "Unreadable amount" };
  }
  const cuts = [picked.amount, picked.balance].sort((a, b) => a.start - b.start);
  let desc = "";
  let cursor = 0;
  for (const c of cuts) {
    desc += flat.slice(cursor, c.start);
    cursor = c.end;
  }
  desc += flat.slice(cursor);
  return { description: tidyDescription(desc), type, amount: picked.amount.minor, balance: picked.balance.minor };
}

interface Piece { label: string; chunk: string }

/**
 * The amount/balance of a row can be printed on the next page, after that page's first date line,
 * so they show up as leading numbers on the following row. Move them back when that restores the
 * running balance (or when this is the first row and there is nothing to check against).
 */
function stitchFromNext(pieces: Piece[], index: number, prevBalance?: bigint): void {
  const next = pieces[index + 1];
  if (!next) return;
  const cur = flatten(pieces[index].chunk);
  const have = columnTokens(cur);
  if (have.length >= 2) return;
  const need = 2 - have.length;
  const nxt = flatten(next.chunk);
  const nextTokens = columnTokens(nxt);
  const letter = nxt.search(/[A-Za-z]/);
  const leading = letter < 0 ? nextTokens : nextTokens.filter((t) => t.start < letter);
  if (leading.length < need || nextTokens.length - need < 2) return;
  const cut = leading[need - 1].end;
  const candidate = `${cur} ${nxt.slice(0, cut)}`.trim();
  const picked = interpret(columnTokens(candidate));
  if ("error" in picked) return;
  const type: TransactionType = picked.amount.paren ? "DEBIT" : "CREDIT";
  if (prevBalance !== undefined && !continues(prevBalance, type, picked.amount.minor, picked.balance.minor)) return;
  pieces[index].chunk = candidate;
  next.chunk = nxt.slice(cut).trim();
}

export function parsePesaStatement(text: string): { result: StatementParseResult; currency: string } | null {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\f/g, "\n");
  if (!looksLikePesa(normalized)) return null;
  const cut = normalized.search(/transaction\s+details/i);
  const preamble = cut >= 0 ? normalized.slice(0, cut) : normalized;
  const table = joinWrappedDates(stripChrome(cut >= 0 ? normalized.slice(cut) : normalized));
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

  const pieces: Piece[] = dates.map((d, i) => ({
    label: d.label,
    chunk: table.slice(d.end, dates[i + 1]?.index ?? table.length),
  }));

  let prevBalance: bigint | undefined;
  pieces.forEach((piece, i) => {
    const row = i + 1;
    stitchFromNext(pieces, i, prevBalance);
    const raw = piece.chunk.replace(/\s+/g, " ").trim().slice(0, 300);
    const date = parseBankDate(piece.label);
    if (!date) {
      errors.push({ row, reason: "Unreadable date", raw });
      return;
    }
    const tail = parseTail(piece.chunk, prevBalance);
    if ("error" in tail) {
      errors.push({ row, reason: tail.error, raw });
      return;
    }
    prevBalance = tail.balance;
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
