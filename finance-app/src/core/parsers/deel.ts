import { createHash } from "node:crypto";
import { moneyCell, type Cell, type StatementParseResult } from "../statements";
import type { CanonicalTransaction, TransactionType } from "../types";
import { parseBankDate } from "./text";

// Deel transaction export. Only completed rows post. Withdrawals that state an NGN
// exchange rate (or the NGN amount transferred) carry that quote for FX learning.

const norm = (v: Cell) => String(v ?? "").toLowerCase().replace(/[^a-z]/g, "");

const COLUMNS: Record<string, string> = {
  id: "id",
  daterequested: "date",
  transactionstatus: "status",
  transactiontype: "type",
  currency: "currency",
  transactionamount: "amount",
  amounttransferred: "transferred",
  currencytransferred: "transferredCurrency",
  client: "client",
  contractname: "contract",
  withdrawmethod: "method",
  withdrawmethodcustomname: "methodName",
  withdrawaccountholdername: "holder",
  traceid: "trace",
  exchangerate: "rate",
};

type ColKey = (typeof COLUMNS)[keyof typeof COLUMNS];

function columnIndex(header: Cell[]): Partial<Record<ColKey, number>> {
  const cells = header.map(norm);
  const cols: Partial<Record<ColKey, number>> = {};
  for (const [name, key] of Object.entries(COLUMNS)) {
    const idx = cells.indexOf(name);
    if (idx >= 0) cols[key] = idx;
  }
  return cols;
}

function textCell(row: Cell[], idx: number | undefined): string {
  if (idx === undefined) return "";
  const v = row[idx];
  if (v instanceof Date) return v.toISOString();
  return String(v ?? "").trim();
}

/** Naira minor units for `foreignMinor` (USD cents) at a rate that may have more than 2 decimals. */
export function ngnMinorFromRate(foreignMinor: bigint, rateRaw: string): bigint | null {
  const m = rateRaw.trim().replace(/,/g, "").match(/^(\d+)(?:\.(\d+))?$/);
  if (!m || foreignMinor <= 0n) return null;
  const frac = m[2] ?? "";
  const scale = 10n ** BigInt(frac.length);
  const rateScaled = BigInt(m[1]) * scale + (frac ? BigInt(frac) : 0n);
  if (rateScaled <= 0n || scale === 0n) return null;
  return (foreignMinor * rateScaled + scale / 2n) / scale;
}

function describe(type: string, client: string, contract: string, holder: string, methodName: string, transferredCurrency: string): string {
  switch (type) {
    case "client_payment":
      return [client, "Deel client payment", contract].filter(Boolean).join(" / ");
    case "withdrawal": {
      const who = holder || methodName || "your bank";
      const bits = [`Money transfer to ${who}`, "Deel withdrawal"];
      if (methodName && holder) bits.push(methodName);
      if (transferredCurrency) bits.push(transferredCurrency);
      return bits.join(" / ");
    }
    case "deel_card_withdrawal":
      return "Deel card withdrawal";
    case "advance":
      return "Deel advance";
    case "advance_fee":
      return "Deel advance fee";
    case "advance_repayment":
      return "Deel advance repayment";
    default:
      return ["Deel", type.replace(/_/g, " "), client].filter(Boolean).join(" / ");
  }
}

function majorityHolder(names: string[]): string | undefined {
  const counts = new Map<string, { n: number; display: string }>();
  for (const name of names) {
    const display = name.replace(/\s+/g, " ").trim();
    const key = display.toUpperCase().replace(/[^A-Z]/g, "");
    if (key.length < 4) continue;
    const g = counts.get(key) ?? { n: 0, display };
    g.n++;
    if (display.length > g.display.length) g.display = display;
    counts.set(key, g);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.display;
}

function mode(xs: string[]): string {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
}

function rowDate(v: Cell): Date | undefined {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (typeof v === "string" || typeof v === "number") return parseBankDate(String(v));
  return undefined;
}

export function parseDeelCsv(rows: Cell[][]): { result: StatementParseResult; currency: string } | null {
  const headerIdx = rows.findIndex((r) => {
    const cells = r.map(norm);
    return cells.includes("daterequested") && cells.includes("transactionstatus") && cells.includes("transactiontype") && cells.includes("transactionamount");
  });
  if (headerIdx < 0) return null;
  const cols = columnIndex(rows[headerIdx]);
  const errors: StatementParseResult["errors"] = [];
  const transactions: CanonicalTransaction[] = [];
  const holderNames: string[] = [];
  const currencies: string[] = [];
  const seen = new Map<string, number>();
  let rowsRead = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => c === null || c === undefined || String(c).trim() === "")) continue;
    rowsRead++;
    const rowNo = i + 1;
    const raw = r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : String(c ?? "").trim())).filter(Boolean).join(" | ").slice(0, 300);
    const status = textCell(r, cols.status).toLowerCase();
    // cancelled / failure (and anything else) never post.
    if (status !== "completed") continue;

    const typeName = textCell(r, cols.type).toLowerCase();
    const signed = moneyCell(r[cols.amount!]);
    const date = rowDate(r[cols.date!]);
    if (!date) {
      errors.push({ row: rowNo, reason: "Unreadable date", raw });
      continue;
    }
    if (signed === null || signed === 0n) {
      errors.push({ row: rowNo, reason: "Unreadable amount", raw });
      continue;
    }
    const type: TransactionType = signed < 0n ? "DEBIT" : "CREDIT";
    const amountMinor = signed < 0n ? -signed : signed;
    const currency = (textCell(r, cols.currency) || "USD").toUpperCase();
    const transferredCurrency = textCell(r, cols.transferredCurrency).toUpperCase();
    const holder = textCell(r, cols.holder);
    const methodName = textCell(r, cols.methodName);
    const client = textCell(r, cols.client);
    const description = describe(typeName, client, textCell(r, cols.contract), holder, methodName, transferredCurrency).slice(0, 280);
    if (typeName === "withdrawal" && holder) holderNames.push(holder);

    let fxQuoteCurrency: string | undefined;
    let fxQuoteMinor: bigint | undefined;
    if (typeName === "withdrawal" && transferredCurrency === "NGN") {
      const transferred = cols.transferred !== undefined ? moneyCell(r[cols.transferred]) : null;
      const fromAmount = transferred && transferred !== 0n ? (transferred < 0n ? -transferred : transferred) : null;
      const fromRate = ngnMinorFromRate(amountMinor, textCell(r, cols.rate));
      const quote = fromAmount ?? fromRate;
      if (quote && quote > 0n) {
        fxQuoteCurrency = "NGN";
        fxQuoteMinor = quote;
      }
    }

    const id = textCell(r, cols.id);
    const trace = textCell(r, cols.trace);
    const baseId = id || createHash("sha256").update(raw).digest("hex").slice(0, 16);
    const n = (seen.get(baseId) ?? 0) + 1;
    seen.set(baseId, n);
    currencies.push(currency);
    transactions.push({
      institution: "Deel",
      source: "statement",
      sourceTransactionId: n === 1 ? `deel:${baseId}` : `deel:${baseId}#${n}`,
      type,
      amountMinor,
      currency,
      transactionDate: date,
      description,
      reference: (trace || id || undefined)?.slice(0, 80),
      fxQuoteCurrency,
      fxQuoteMinor,
      confidence: 1,
    });
  }

  const holder = majorityHolder(holderNames);
  if (holder) for (const t of transactions) t.accountHolder = holder;
  return { currency: mode(currencies), result: { transactions, errors, rowsRead, holder } };
}
