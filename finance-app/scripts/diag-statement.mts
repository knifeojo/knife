// Prints the STRUCTURE of a statement (headers, counts, cell shapes, errors) with no amounts or names.
// Usage: PDF_PASSWORD=... npx tsx --tsconfig tsconfig.json scripts/diag-statement.mts <file.pdf>
import { readFileSync } from "node:fs";
import { pdfToSections } from "../src/core/pdf-statement.ts";
import { detectStatementMeta, findColumns, isHeader, parseStatementRows, reconcile } from "../src/core/statements.ts";

const file = process.argv[2];
const password = process.env.PDF_PASSWORD || undefined;
// Words that appear in column headings. Only cells made of these words are printed verbatim.
const HEADING_WORDS = /^(s\/?n|no\.?|date|dates|trans\.?|transaction|transactions|txn|tran|value|val\.?|posting|posted|post|entry|desc\.?|description|narration|narrative|details|detail|remarks?|particulars|memo|debits?|credits?|dr|cr|withdrawals?|deposits?|lodgements?|amount|amt|balance|bal\.?|running|closing|available|ref\.?|reference|references|number|no|type|channel|money|in|out|paid|cheque|chq|branch|originating|time|session|id|currency|charges?|fees?|of|\(ngn\)|ngn|\(₦\)|₦|\/|&|-|\.)$/i;
const isHeadingText = (s: string) => s.split(/\s+/).filter(Boolean).every((w) => HEADING_WORDS.test(w));
const shape = (c: unknown) => {
  const s = String(c ?? "").trim();
  if (!s) return "_";
  if (/^\(?-?\s*(NGN|₦)?\s*[\d,]+\.\d{2}\)?(\s*(CR|DR))?$/i.test(s)) return "money";
  if (/\d{1,4}[\/\-. ](\d{1,2}|[A-Za-z]{3,9})[\/\-. ,]+\d{2,4}/.test(s)) return "date";
  if (isHeadingText(s)) return `"${s}"`;
  return `text(${s.length})`;
};
try {
  const sections = await pdfToSections(readFileSync(file), password);
  const allFooter = sections.map((x) => x.otherText).join("\n");
  for (const [n, { rows }] of sections.entries()) {
  const otherText = allFooter;
  console.log(`\n--- account section ${n + 1} of ${sections.length}`);
  const headerIdx = rows.findIndex((r) => isHeader(findColumns(r)));
  console.log("raw rows:", rows.length, "| header row index:", headerIdx);
  if (headerIdx >= 0) console.log("header cells:", JSON.stringify(rows[headerIdx]));
  console.log("meta:", detectStatementMeta(rows, file.split("/").pop(), otherText));
  console.log("first rows (shapes):");
  for (const r of rows.slice(0, headerIdx >= 0 ? headerIdx + 6 : 40)) console.log("  ", r.map(shape).join(" | "));
  const p = parseStatementRows(rows, { institution: "Unknown" });
  const t = p.transactions;
  console.log("transactions:", t.length, "| debits:", t.filter((x) => x.type === "DEBIT").length, "| credits:", t.filter((x) => x.type === "CREDIT").length,
    "| with balance:", t.filter((x) => x.balanceAfterMinor !== undefined).length, "| with ref:", t.filter((x) => x.reference).length, "| acct last4 found:", !!p.accountLast4);
  const sum = (xs: typeof t) => xs.reduce((s, x) => s + x.amountMinor, 0n);
  const rec = reconcile(t);
  const breaks = rec.breaks;
  console.log("running-balance breaks (beyond 1-unit rounding):", breaks, "| gap (minor units):", rec.gapMinor.toString(), "| debit total (kobo):", sum(t.filter((x) => x.type === "DEBIT")).toString(), "| credit total (kobo):", sum(t.filter((x) => x.type === "CREDIT")).toString());
  if (t.length) console.log("date range:", t[0].transactionDate.toISOString().slice(0, 10), "to", t[t.length - 1].transactionDate.toISOString().slice(0, 10));
  // Original row text is masked: letters and digits become shapes, so nothing personal is printed.
  console.log("errors:", p.errors.length, JSON.stringify(p.errors.slice(0, 30).map((e) => ({ row: e.row, reason: e.reason, raw: (e.raw ?? "").replace(/[A-Za-z]{2,}/g, "w").replace(/\d/g, "#") }))));
  const errRows = new Set(p.errors.slice(0, 30).map((e) => e.row - 1));
  for (const i of errRows) console.log("  error row shape:", rows[i]?.map(shape).join(" | "));
  }
} catch (e) {
  console.log("ERROR:", (e as Error).message);
}
