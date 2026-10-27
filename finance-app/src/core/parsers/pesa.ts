import { createHash } from "node:crypto";
import { parseAmountToMinor } from "@/lib/money";
import { lagosDay } from "../dedup";
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
 * Wallet ids start with a country prefix (CA / US / GB / EU / NG), letters or digits after it.
 * "CAOO…" and "CA00…" are both CAD; "USOO…" is USD. An explicit "Currency: GBP" still wins.
 */
export function pesaCurrency(preamble: string, wallet?: string): string {
  const labeled = preamble.match(/\bcurrency\s*:\s*(USD|CAD|GBP|EUR|NGN)\b/i)?.[1]?.toUpperCase();
  if (labeled) return labeled;
  const namedWallet = preamble.match(/\b(USD|CAD|GBP|EUR|NGN)\s+wallet\b/i)?.[1]?.toUpperCase();
  if (namedWallet) return namedWallet;
  if (wallet && /^CA[A-Z0-9]/i.test(wallet)) return "CAD";
  if (wallet && /^GB[A-Z0-9]/i.test(wallet)) return "GBP";
  if (wallet && /^EU[A-Z0-9]/i.test(wallet)) return "EUR";
  if (wallet && /^NG[A-Z0-9]/i.test(wallet)) return "NGN";
  if (wallet && /^US[A-Z0-9]/i.test(wallet)) return "USD";
  const explicit = preamble.match(/\b(USD|CAD|GBP|EUR|NGN)\b/i)?.[1]?.toUpperCase();
  if (explicit) return explicit;
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

/** Column order on a normal row: the last two money tokens are amount, then balance. */
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

interface Reading { amount: Tok; balance: Tok }

function readingScore(reading: Reading, tokens: Tok[]): number {
  let score = 0;
  if (reading.balance === tokens[tokens.length - 1]) score += 4;
  if (reading.amount.paren) score += 2;
  if (reading.amount === tokens[tokens.length - 2]) score += 1;
  return score;
}

/**
 * Every way to read a parenthetical debit plus a plain balance out of a row that also picked up
 * the next row's balance. The standard "last two tokens" reading is preferred when it continues.
 */
function alternateReadings(tokens: Tok[]): Reading[] {
  const out: Reading[] = [];
  for (const amount of tokens) {
    if (!amount.paren) continue;
    for (const balance of tokens) {
      if (balance.paren || balance === amount) continue;
      out.push({ amount, balance });
    }
  }
  return out;
}

function tidyDescription(desc: string): string {
  return desc.replace(/(?:\s*\()+\s*$/g, "").replace(/\s+/g, " ").trim();
}

interface Tail {
  description: string;
  type: TransactionType;
  amount: bigint;
  balance: bigint;
  /** Balance was not printed; it was inferred from the previous row and checked against the next one. */
  inferred: boolean;
  /** Money tokens that belong to the following row (its balance landed before the next date). */
  spill: string;
}

function describe(flat: string, drop: Tok[]): string {
  let desc = "";
  let cursor = 0;
  for (const c of [...drop].sort((a, b) => a.start - b.start)) {
    desc += flat.slice(cursor, c.start);
    cursor = c.end;
  }
  desc += flat.slice(cursor);
  return tidyDescription(desc);
}

const REVERSAL = /\b(?:reversed|reversal|rvsl)\b|\brev\//i;

function structuralReading(chunk: string): { type: TransactionType; amount: bigint; balance: bigint } | undefined {
  const tokens = columnTokens(flatten(chunk));
  const picked = interpret(tokens);
  if ("error" in picked) return undefined;
  return {
    type: picked.amount.paren ? "DEBIT" : "CREDIT",
    amount: picked.amount.minor,
    balance: picked.balance.minor,
  };
}

function fitsNext(balance: bigint, next: { type: TransactionType; amount: bigint; balance: bigint } | undefined): boolean {
  if (!next) return false;
  return continues(balance, next.type, next.amount, next.balance);
}

function parseTail(raw: string, prevBalance?: bigint, nextChunk?: string): Tail | { error: string } {
  const flat = flatten(raw);
  if (!flat) return { error: "No debit or credit amount" };
  const untagged = columnTokens(flat);
  // The amount column was captured and the balance column was not. Parentheses are a debit unless
  // the following row only continues when this one is a credit (a payout reversal).
  if (untagged.length === 1 && untagged[0].paren && prevBalance !== undefined) {
    const amount = untagged[0];
    const next = nextChunk ? structuralReading(nextChunk) : undefined;
    const debitBalance = prevBalance - amount.minor;
    const creditBalance = prevBalance + amount.minor;
    const debitFits = fitsNext(debitBalance, next);
    const creditFits = fitsNext(creditBalance, next);
    const reversal = REVERSAL.test(flat);
    const type: TransactionType = creditFits && !debitFits ? "CREDIT" : debitFits && !creditFits ? "DEBIT" : reversal && !debitFits ? "CREDIT" : "DEBIT";
    const balance = type === "CREDIT" ? creditBalance : debitBalance;
    return { description: describe(flat, [amount]), type, amount: amount.minor, balance, inferred: true, spill: "" };
  }
  const standard = interpret(untagged);
  if ("error" in standard) return standard;
  let chosen = standard;
  const standardType: TransactionType = standard.amount.paren ? "DEBIT" : "CREDIT";
  const standardContinues = prevBalance !== undefined && continues(prevBalance, standardType, standard.amount.minor, standard.balance.minor);
  // A following balance glued onto this row makes the last two tokens a huge false credit. Prefer the
  // parenthetical debit whose plain balance actually follows from the previous row.
  if (prevBalance !== undefined && !standardContinues) {
    const better = alternateReadings(untagged)
      .filter((r) => continues(prevBalance, "DEBIT", r.amount.minor, r.balance.minor))
      .sort((a, b) => readingScore(b, untagged) - readingScore(a, untagged));
    if (better[0]) chosen = better[0];
  }
  const type: TransactionType = chosen.amount.paren ? "DEBIT" : "CREDIT";
  // Only the out-of-order reading is checked. A normal "amount then balance" row is kept even when
  // the statement's balance resets (a new period), which is what the synthetic wallet fixture does.
  const scrambled = chosen.amount === untagged[untagged.length - 1] && chosen.amount.paren;
  if (scrambled && prevBalance !== undefined && !continues(prevBalance, type, chosen.amount.minor, chosen.balance.minor)) {
    return { error: "Unreadable amount" };
  }
  const letter = flat.search(/[A-Za-z]/);
  const unused = untagged.filter((t) => t !== chosen.amount && t !== chosen.balance);
  const trailing = unused.filter((t) => t.start >= chosen.balance.end).sort((a, b) => a.start - b.start);
  const leading = unused.filter((t) => !trailing.includes(t) && (letter < 0 || t.start < letter));
  const spill = trailing.map((t) => flat.slice(t.start, t.end)).join(" ");
  return {
    description: describe(flat, [chosen.amount, chosen.balance, ...leading, ...trailing]),
    type,
    amount: chosen.amount.minor,
    balance: chosen.balance.minor,
    inferred: false,
    spill,
  };
}

interface Draft {
  date: Date;
  description: string;
  type: TransactionType;
  amount: bigint;
  balance: bigint;
  inferred: boolean;
  currency?: string;
  fxQuoteCurrency?: string;
  fxQuoteMinor?: bigint;
}

const WALLET_FX = new RegExp(
  `(\\d{1,3}(?:,\\d{3})*|\\d+)\\.(\\d{2})\\s*(${CCY})\\s+debited from \\w+ wallet to fund \\w+ wallet\\s*\\((\\d{1,3}(?:,\\d{3})*|\\d+)\\.(\\d{2})\\s*(${CCY})`,
  "i",
);

/** "8.12 CAD debited from CAD wallet to fund GBP wallet (4.35GBP)" is CAD, not the statement $ column. */
function applyWalletFx(draft: Draft): Draft {
  const m = draft.description.match(WALLET_FX);
  if (!m) return draft;
  const amount = parseAmountToMinor(`${m[1].replace(/,/g, "")}.${m[2]}`);
  const quote = parseAmountToMinor(`${m[4].replace(/,/g, "")}.${m[5]}`);
  if (amount === null || quote === null) return draft;
  return {
    ...draft,
    amount,
    currency: m[3].toUpperCase(),
    fxQuoteCurrency: m[6].toUpperCase(),
    fxQuoteMinor: quote,
  };
}

/** Assign debit/credit to rows whose balance was not printed, so the next printed balance still follows. */
function settleInferred(rows: Draft[]) {
  let i = 0;
  while (i < rows.length) {
    if (!rows[i].inferred) { i++; continue; }
    let j = i;
    while (j < rows.length && rows[j].inferred) j++;
    const prev = i > 0 ? rows[i - 1].balance : undefined;
    const run = rows.slice(i, j);
    const anchor = rows[j];
    if (prev === undefined) { i = j; continue; }
    // No later printed balance to judge against: keep the debit-or-reversal choice made while parsing.
    if (!anchor) {
      let bal = prev;
      for (const row of run) {
        bal = row.type === "CREDIT" ? bal + row.amount : bal - row.amount;
        row.balance = bal;
        row.inferred = false;
      }
      i = j;
      continue;
    }
    let best: number | undefined;
    let bestScore = Infinity;
    const limit = run.length <= 8 ? 1 << run.length : 0;
    for (let mask = 0; mask < limit; mask++) {
      let bal = prev;
      let credits = 0;
      let oddCredits = 0;
      for (let k = 0; k < run.length; k++) {
        const credit = (mask >> k) & 1;
        if (credit) {
          credits++;
          if (!REVERSAL.test(run[k].description)) oddCredits++;
          bal += run[k].amount;
        } else bal -= run[k].amount;
      }
      const expected = anchor.type === "CREDIT" ? bal + anchor.amount : bal - anchor.amount;
      const diff = expected > anchor.balance ? expected - anchor.balance : anchor.balance - expected;
      if (diff > 1n) continue;
      const score = credits + oddCredits * 10;
      if (score < bestScore) { bestScore = score; best = mask; }
    }
    let bal = prev;
    for (let k = 0; k < run.length; k++) {
      const credit = best !== undefined && ((best >> k) & 1) === 1;
      const type: TransactionType = best === undefined ? run[k].type : credit ? "CREDIT" : "DEBIT";
      bal = type === "CREDIT" ? bal + run[k].amount : bal - run[k].amount;
      run[k].type = type;
      run[k].balance = bal;
      run[k].inferred = false;
    }
    i = j;
  }
}

function forwardBreaks(prev: bigint | undefined, rows: Draft[]): number {
  let breaks = 0;
  let cursor = prev;
  for (const row of rows) {
    if (cursor !== undefined && !continues(cursor, row.type, row.amount, row.balance)) breaks++;
    cursor = row.balance;
  }
  return breaks;
}

/**
 * Same-day rows share one timestamp, and a page break can emit them out of balance order.
 * Within one Lagos day, pull forward the unused row that follows from the running balance.
 * Keep the extracted order when that does not remove a break.
 */
function reorderSameDay(rows: Draft[]) {
  const next: Draft[] = [];
  let i = 0;
  while (i < rows.length) {
    const day = lagosDay(rows[i].date);
    let j = i + 1;
    while (j < rows.length && lagosDay(rows[j].date) === day) j++;
    const group = rows.slice(i, j);
    const prev = next.length ? next[next.length - 1].balance : undefined;
    if (group.length < 2 || prev === undefined || group.some((r) => r.inferred)) {
      next.push(...group);
    } else {
      const pool = [...group];
      const arranged: Draft[] = [];
      let cursor = prev;
      while (pool.length) {
        const fit = pool.findIndex((t) => continues(cursor, t.type, t.amount, t.balance));
        const [take] = pool.splice(fit >= 0 ? fit : 0, 1);
        arranged.push(take);
        cursor = take.balance;
      }
      next.push(...(forwardBreaks(prev, arranged) < forwardBreaks(prev, group) ? arranged : group));
    }
    i = j;
  }
  rows.splice(0, rows.length, ...next);
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
  const drafts: Draft[] = [];
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
    const tail = parseTail(piece.chunk, prevBalance, pieces[i + 1]?.chunk);
    if ("error" in tail) {
      errors.push({ row, reason: tail.error, raw });
      return;
    }
    if (tail.spill && pieces[i + 1]) pieces[i + 1].chunk = `${tail.spill} ${pieces[i + 1].chunk}`.trim();
    prevBalance = tail.balance;
    drafts.push(applyWalletFx({
      date,
      description: (tail.description || "Pesa transaction").slice(0, 280),
      type: tail.type,
      amount: tail.amount,
      balance: tail.balance,
      inferred: tail.inferred,
    }));
  });

  reorderSameDay(drafts);
  settleInferred(drafts);

  const transactions: CanonicalTransaction[] = [];
  const seen = new Map<string, number>();
  for (const draft of drafts) {
    const key = ["Pesa", accountLast4 ?? "", draft.date.toISOString().slice(0, 10), draft.description, draft.type, draft.amount.toString(), draft.balance.toString()].join("|");
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const sourceTransactionId = createHash("sha256").update(`${key}#${n}`).digest("hex").slice(0, 32);
    transactions.push({
      institution: "Pesa",
      source: "statement",
      sourceTransactionId,
      type: draft.type,
      amountMinor: draft.amount,
      currency: draft.currency ?? currency,
      transactionDate: draft.date,
      description: draft.description,
      balanceAfterMinor: draft.balance,
      accountLast4,
      accountHolder: holder,
      fxQuoteCurrency: draft.fxQuoteCurrency,
      fxQuoteMinor: draft.fxQuoteMinor,
      confidence: 1,
    });
  }

  return {
    currency,
    result: { transactions, errors, accountLast4, rowsRead: dates.length, holder },
  };
}
