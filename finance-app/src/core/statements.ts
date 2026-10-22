import { createHash } from "node:crypto";
import { parseAmountToMinor } from "@/lib/money";
import { parseBankDate } from "./parsers/text";
import type { CanonicalTransaction, TransactionType } from "./types";
import { inferHolderName } from "./categorize";

// Bank statement import (CSV / XLSX rows). Column-header driven, so it copes with the usual
// preamble rows (bank name, account number, period) above the table and with either
// separate Debit/Credit columns or one signed Amount column.

export type Cell = string | number | boolean | Date | null | undefined;

export interface StatementParseResult {
  transactions: CanonicalTransaction[];
  errors: { row: number; reason: string; raw?: string }[];
  accountLast4?: string;
  rowsRead: number;
  holder?: string;
}

/** RFC 4180 CSV: quoted fields, escaped quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (v: Cell) => String(v ?? "").toLowerCase().replace(/[^a-z]/g, "");

const HEADERS = {
  date: ["transdate", "transactiondate", "txndate", "date", "postingdate", "postdate", "tradedate", "valuedate"],
  description: ["narration", "narrative", "description", "remarks", "details", "transactiondetails", "particulars", "memo"],
  debit: ["debit", "debits", "debitamount", "withdrawal", "withdrawals", "dr", "moneyout", "paidout"],
  credit: ["credit", "credits", "creditamount", "deposit", "deposits", "lodgement", "lodgements", "cr", "moneyin", "paidin"],
  amount: ["amount", "transactionamount", "amt"],
  type: ["type", "drcr", "transactiontype", "debitcredit"],
  balance: ["balance", "runningbalance", "closingbalance", "availablebalance", "balanceafter"],
  reference: ["reference", "ref", "referenceno", "referencenumber", "transactionreference", "documentno", "documentnumber", "chequeno", "sessionid"],
};
type Col = keyof typeof HEADERS;

export function findColumns(row: Cell[]): Partial<Record<Col, number>> {
  const cols: Partial<Record<Col, number>> = {};
  const cells = row.map(norm);
  for (const key of Object.keys(HEADERS) as Col[]) {
    // Priority follows the synonym order, so "Trans Date" beats "Value Date" when both exist.
    for (const syn of HEADERS[key]) {
      const idx = cells.findIndex((c, i) => c === syn && !Object.values(cols).includes(i));
      if (idx >= 0) { cols[key] = idx; break; }
    }
  }
  return cols;
}

export function isHeader(cols: Partial<Record<Col, number>>) {
  return cols.date !== undefined && cols.description !== undefined &&
    ((cols.debit !== undefined && cols.credit !== undefined) || cols.amount !== undefined);
}

/** Money cell to signed minor units. Accepts numbers, "1,234.50", "₦1,234.50", "(1,234.50)", "-1234.5". */
export function moneyCell(v: Cell): bigint | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? BigInt(Math.round(v * 100)) : null;
  let s = String(v).trim();
  if (!s || s === "-" || s === "--") return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith("-") || /\bdr\b/i.test(s);
  s = s.replace(/[()₦$£€,\s]|NGN|USD|GBP|EUR|CR|DR/gi, "").replace(/^-/, "");
  const minor = parseAmountToMinor(s);
  if (minor === null) return null;
  return negative ? -minor : minor;
}

function dateCell(v: Cell): Date | undefined {
  if (v instanceof Date && !isNaN(v.getTime())) {
    // Excel dates arrive as UTC midnight of the calendar day; pin to noon Lagos.
    return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate(), 11));
  }
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400_000);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 11));
  }
  if (typeof v === "string") return parseBankDate(v);
  return undefined;
}

function findAccountLast4(preamble: Cell[][]): string | undefined {
  for (const row of preamble) {
    for (let i = 0; i < row.length; i++) {
      const cell = String(row[i] ?? "");
      if (!/account\s*(no|number|num)|^\s*wallet\s*(id|no|number)?\s*:/i.test(cell)) continue;
      const candidates = [cell.split(/[:]/)[1], String(row[i + 1] ?? ""), String(row[i + 2] ?? "")];
      for (const c of candidates) {
        const token = (c ?? "").replace(/\s+/g, "");
        // Only trust the visible trailing digits: "000XXXX533" -> "533", "0001234533" -> "4533".
        const trailing = token.match(/(\d{3,})$/)?.[1];
        if (trailing) return trailing.slice(-4);
        const digits = token.replace(/[^0-9]/g, "");
        if (digits.length >= 4 && !/[x*]/i.test(token)) return digits.slice(-4);
      }
    }
  }
  return undefined;
}

// Bank detection from the statement preamble (and file name). Order matters: specific before generic.
export const BANKS: [RegExp, string][] = [
  [/guaranty trust|gtbank|gtco/i, "GTBank"], [/access bank/i, "Access Bank"], [/zenith/i, "Zenith Bank"],
  [/united bank for africa|\buba\b/i, "UBA"], [/first bank|firstbank/i, "First Bank"], [/fidelity/i, "Fidelity Bank"],
  [/stanbic/i, "Stanbic IBTC"], [/sterling/i, "Sterling Bank"], [/wema|alat/i, "Wema Bank"], [/union bank/i, "Union Bank"],
  [/fcmb|first city monument/i, "FCMB"], [/ecobank/i, "Ecobank"], [/polaris/i, "Polaris Bank"], [/keystone/i, "Keystone Bank"],
  [/providus/i, "Providus Bank"], [/kuda/i, "Kuda"], [/opay/i, "OPay"], [/moniepoint/i, "Moniepoint"], [/palmpay/i, "PalmPay"],
  [/\bpesa\b|pesapeer/i, "Pesa"], [/\bdeel\b/i, "Deel"],
];

export function detectStatementMeta(rows: Cell[][], fileName = "", otherText = ""): { institution?: string; currency?: string } {
  const headerIdx = rows.slice(0, 40).findIndex((r) => isHeader(findColumns(r)));
  const preamble = rows.slice(0, headerIdx >= 0 ? headerIdx : 10).flat().map((c) => String(c ?? "")).join(" ");
  const text = `${fileName.replace(/[-_.]+/g, " ")} ${preamble}`;
  // Preamble and file name first; then footer text (never transaction narrations, which name other banks).
  // Footer text, minus stray narration lines (transfers name the OTHER party's bank, not this one).
  // Real footers are sentences (legal / contact text); short lines are stray narration fragments.
  const footer = otherText
    .split("\n")
    .filter((l) => l.trim().split(/\s+/).length >= 8 && !/transfer|payment|withdraw|deposit|\s\/\s/i.test(l))
    .join("\n");
  const mostMentioned = () => {
    const counts = BANKS.map(([re, name]) => ({ name, n: (footer.match(new RegExp(re.source, "gi")) ?? []).length }));
    const best = counts.sort((a, b) => b.n - a.n)[0];
    return best && best.n > 0 ? best.name : undefined;
  };
  // Last resort: GTBank's export layout ("Originating Branch" + "Remarks" beside Debits/Credits) is distinctive.
  const header = headerIdx >= 0 ? rows[headerIdx].map(norm) : [];
  const gtbLayout = header.includes("originatingbranch") && header.includes("remarks") && header.includes("debits") ? "GTBank" : undefined;
  const institution = BANKS.find(([re]) => re.test(text))?.[1] ?? mostMentioned() ?? gtbLayout;
  const codes = (t: string) => {
    const counts = new Map<string, number>();
    for (const m of t.match(/\b(NGN|USD|GBP|EUR|CAD)\b/gi) ?? []) counts.set(m.toUpperCase(), (counts.get(m.toUpperCase()) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  // Wallet / account IDs that start with a country code ("Wallet: CA00…") identify the currency.
  const idCountry = preamble.match(/\b(?:wallet|account)\s*(?:id|no|number)?\s*:?\s*(CA|US|GB|NG|GH|KE)[A-Z0-9]{6,}/i)?.[1]?.toUpperCase();
  const COUNTRY_CURRENCY: Record<string, string> = { CA: "CAD", US: "USD", GB: "GBP", NG: "NGN", GH: "GHS", KE: "KES" };
  const cur =
    codes(preamble) ??
    (idCountry ? COUNTRY_CURRENCY[idCountry] : undefined) ??
    (/\bnaira\b|₦/i.test(preamble) ? "NGN" : undefined) ??
    // "$" alone is ambiguous: the footer usually says which dollar ("CAD wallet").
    codes(footer) ??
    (/\$|dollar|domiciliary/i.test(preamble) ? "USD" : /£/.test(preamble) ? "GBP" : /€/.test(preamble) ? "EUR" : undefined);
  return { institution, currency: cur };
}

function findAccountName(preamble: Cell[][]): string | undefined {
  for (const row of preamble) {
    for (let i = 0; i < row.length; i++) {
      if (!/^\s*(account|customer)\s*name\s*:?\s*$/i.test(String(row[i] ?? ""))) continue;
      const v = String(row[i + 1] ?? "").trim();
      if (/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(v)) return v;
    }
  }
  return undefined;
}

const SKIP_ROW = /opening balance|closing balance|balance b\/f|balance c\/f|brought forward|carried forward|^total/i;

export function parseStatementRows(
  rows: Cell[][],
  opts: { institution: string; currency?: string; accountLast4?: string },
): StatementParseResult {
  const headerIdx = rows.slice(0, 40).findIndex((r) => isHeader(findColumns(r)));
  if (headerIdx < 0) {
    return { transactions: [], errors: [{ row: 0, reason: "Could not find a header row with Date, Description and Debit/Credit (or Amount) columns." }], rowsRead: 0 };
  }
  const cols = findColumns(rows[headerIdx]);
  const accountLast4 = opts.accountLast4 ?? findAccountLast4(rows.slice(0, headerIdx));
  const currency = opts.currency ?? "NGN";
  const errors: StatementParseResult["errors"] = [];
  const transactions: CanonicalTransaction[] = [];
  const seen = new Map<string, number>();
  let rowsRead = 0;

  // Layout tolerance, without ever guessing money:
  // - Many statements print the date once per day: blank dates inherit the last date seen.
  // - Some print a row's balance on its own line: a balance-only line attaches to the neighbouring
  //   transaction that lacks one.
  // - A line with only a date (and maybe a balance) sets the date for the rows below it.
  // An amount cell that has content but can't be read is ALWAYS reported, never skipped.
  let lastDate: Date | undefined;
  let pendingBalance: bigint | undefined;
  let prev: CanonicalTransaction | undefined;
  const filled = (c: Cell) => c !== null && c !== undefined && String(c).trim() !== "";

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = i + 1;
    if (!r || r.every((c) => !filled(c))) continue;
    const description = String(r[cols.description!] ?? "").replace(/\s+/g, " ").trim();
    if (SKIP_ROW.test(description)) continue;
    rowsRead++;

    const raw = r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c ?? "").trim())).filter(Boolean).join(" | ").slice(0, 300);
    const dateRaw = r[cols.date!];
    let ownDate = dateCell(dateRaw);
    // "Sep 4," with the year wrapped onto another line: take the year from the row above.
    const yearless = String(dateRaw ?? "").trim().match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?$/);
    if (!ownDate && yearless && lastDate) ownDate = parseBankDate(`${yearless[1]} ${yearless[2]}, ${new Date(lastDate.getTime() + 3600_000).getUTCFullYear()}`);
    if (filled(dateRaw) && !ownDate && !/^\d+$/.test(String(dateRaw).trim())) { errors.push({ row: rowNo, reason: "Unreadable date", raw }); continue; }
    if (ownDate) lastDate = ownDate; // a readable date applies to the rows below even if this row fails

    let type: TransactionType | undefined;
    let amount: bigint | null = null;
    const amountCells = cols.debit !== undefined && cols.credit !== undefined ? [r[cols.debit], r[cols.credit]] : cols.amount !== undefined ? [r[cols.amount]] : [];
    if (cols.debit !== undefined && cols.credit !== undefined) {
      const d = moneyCell(r[cols.debit]);
      const c = moneyCell(r[cols.credit]);
      if (d && d !== 0n) { type = "DEBIT"; amount = d < 0n ? -d : d; }
      else if (c && c !== 0n) { type = "CREDIT"; amount = c < 0n ? -c : c; }
    } else if (cols.amount !== undefined) {
      const a = moneyCell(r[cols.amount]);
      const t = cols.type !== undefined ? norm(r[cols.type]) : "";
      if (a !== null && a !== 0n) {
        type = /^(dr|debit|d)$/.test(t) ? "DEBIT" : /^(cr|credit|c)$/.test(t) ? "CREDIT" : a < 0n ? "DEBIT" : "CREDIT";
        amount = a < 0n ? -a : a;
      }
    }
    const balance = cols.balance !== undefined ? moneyCell(r[cols.balance]) ?? undefined : undefined;

    if (!type || amount === null) {
      // Content in an amount cell that isn't a readable number: report it.
      if (amountCells.some((c) => filled(c) && moneyCell(c) === null)) { errors.push({ row: rowNo, reason: "Unreadable amount", raw }); continue; }
      // Date-only and balance-only lines are layout; a dated line WITH words but no amount is suspicious.
      if (ownDate && description) { errors.push({ row: rowNo, reason: "No debit or credit amount", raw }); continue; }
      const usedAsLayout = !!ownDate || balance !== undefined;
      if (ownDate) lastDate = ownDate;
      if (balance !== undefined) {
        if (prev && prev.balanceAfterMinor === undefined) prev.balanceAfterMinor = balance;
        else pendingBalance = balance;
      }
      if (!usedAsLayout) {
        if (description && prev) prev.description = `${prev.description} ${description}`.slice(0, 280); // wrapped narration
        else errors.push({ row: rowNo, reason: "No debit or credit amount", raw });
      }
      rowsRead--;
      continue;
    }

    const date = ownDate ?? lastDate;
    if (!date) { errors.push({ row: rowNo, reason: "Unreadable date", raw }); continue; }
    lastDate = date;
    const bal = balance ?? pendingBalance;
    pendingBalance = undefined;
    const reference = cols.reference !== undefined ? String(r[cols.reference] ?? "").trim() || undefined : undefined;

    // Stable id per row content, so re-uploading the same or an overlapping statement is a no-op.
    const key = [opts.institution, accountLast4 ?? "", date.toISOString().slice(0, 10), description, type, amount, bal ?? "", reference ?? ""].join("|");
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const sourceTransactionId = createHash("sha256").update(`${key}#${n}`).digest("hex").slice(0, 32);

    const tx: CanonicalTransaction = {
      institution: opts.institution,
      source: "statement",
      sourceTransactionId,
      type,
      amountMinor: amount,
      currency,
      transactionDate: date,
      description: description || `${opts.institution} ${type.toLowerCase()}`,
      reference,
      balanceAfterMinor: bal,
      accountLast4,
      confidence: 1,
    };
    transactions.push(tx);
    prev = tx;
  }
  const holder = findAccountName(rows.slice(0, headerIdx)) ?? inferHolderName(transactions.filter((t) => t.type === "DEBIT").map((t) => t.description));
  if (holder) for (const t of transactions) t.accountHolder = holder;
  return { transactions, errors, accountLast4, rowsRead, holder };
}

/**
 * Checks imported rows against the statement's own running balance. Banks list rows oldest-first or
 * newest-first, so both orders are tried and the better fit is used. Returns how many rows broke the
 * chain and the total money the imported rows fail to account for.
 *
 * A bad middle balance (or a row read out of order) makes one link miss by D and the next link miss
 * by −D once the printed balance is right again. That is one discontinuity of |D|, not two.
 */
export function reconcile(transactions: { type: string; amountMinor: bigint; balanceAfterMinor?: bigint }[]): { breaks: number; gapMinor: bigint; checked: number } {
  const check = (txs: typeof transactions) => {
    let breaks = 0, gap = 0n, checked = 0;
    let open: bigint | null = null;
    const commit = (signed: bigint) => {
      const abs = signed < 0n ? -signed : signed;
      if (abs <= 1n) return;
      breaks++;
      gap += abs;
    };
    const closeOpen = () => {
      if (open === null) return;
      commit(open);
      open = null;
    };
    for (let i = 1; i < txs.length; i++) {
      const prev = txs[i - 1].balanceAfterMinor, cur = txs[i].balanceAfterMinor;
      if (prev === undefined || cur === undefined) {
        closeOpen();
        continue;
      }
      checked++;
      const expected = prev + (txs[i].type === "CREDIT" ? txs[i].amountMinor : -txs[i].amountMinor);
      const signed = cur - expected;
      const abs = signed < 0n ? -signed : signed;
      // A 1-minor-unit difference is the bank's own rounding (e.g. FX conversion), not missing money.
      if (abs <= 1n) {
        closeOpen();
        continue;
      }
      if (open !== null) {
        const cancel = open + signed;
        const cancelAbs = cancel < 0n ? -cancel : cancel;
        if (cancelAbs <= 1n) {
          commit(open);
          open = null;
          continue;
        }
        commit(open);
      }
      open = signed;
    }
    closeOpen();
    return { breaks, gapMinor: gap, checked };
  };
  const forward = check(transactions);
  // Newest-first statements: walk them backwards so each row follows from the one before it in time.
  const backward = check([...transactions].reverse());
  return backward.breaks < forward.breaks ? backward : forward;
}
