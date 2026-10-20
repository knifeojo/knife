import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { ingestTransaction, loadOwners, loadUserRules } from "./ledger";
import { detectStatementMeta, moneyCell, parseCsv, parseStatementRows, reconcile, type Cell, type StatementParseResult } from "./statements";
import { parseBankDate } from "./parsers/text";
import { parseDeelCsv } from "./parsers/deel";
import { parsePesaStatement } from "./parsers/pesa";
import { parseAmountToMinor } from "@/lib/money";
import { formatMoney } from "@/lib/money";
import { PdfStatementError, pdfToPlainText, pdfToSections } from "./pdf-statement";
import { pairOwnTransfers } from "./transfers";

export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;
export const MAX_STATEMENT_FILES = 10;
const MAX_ROWS = 20_000;

export interface StatementImportSummary {
  /** Further accounts found in the same file (e.g. a savings account on the last page). */
  others?: StatementImportSummary[];
  institution: string;
  currency: string;
  rowsRead: number;
  created: number;
  duplicates: number;
  errors: { row: number; reason: string; raw?: string }[];
  accountLast4?: string;
  /** Rows where the running balance did not follow, and the money unaccounted for (formatted). */
  balanceBreaks: number;
  gap: string | null;
  /** True only when every row was read and the running balance checks out. */
  complete: boolean;
}

export class StatementFormatError extends Error {}

type Section = {
  rows: Cell[][];
  otherText?: string;
  /** Set when a format-specific parser already produced transactions (Pesa PDF, Deel CSV). */
  direct?: StatementParseResult;
  institution?: string;
  currency?: string;
};

function deelSection(rows: Cell[][]): Section | undefined {
  const deel = parseDeelCsv(rows);
  if (!deel) return undefined;
  return { rows: [], direct: deel.result, institution: "Deel", currency: deel.currency };
}

/** A file yields one section per account (PDFs can hold several accounts). */
async function readSections(fileName: string, bytes: Buffer, password?: string): Promise<Section[]> {
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "csv" || ext === "txt") {
    const rows = parseCsv(bytes.toString("utf8"));
    return [deelSection(rows) ?? { rows }];
  }
  if (ext === "xlsx") {
    const { readSheet } = await import("read-excel-file/node");
    const rows = (await readSheet(bytes)) as Cell[][];
    return [deelSection(rows) ?? { rows }];
  }
  if (ext === "xls") throw new StatementFormatError("Old .xls files are not supported. Open it in Excel or Google Sheets and save as .xlsx or .csv.");
  if (ext === "pdf") {
    try {
      const text = await pdfToPlainText(bytes, password);
      const pesa = parsePesaStatement(text);
      if (pesa) return [{ rows: [], direct: pesa.result, institution: "Pesa", currency: pesa.currency }];
      return await pdfToSections(bytes, password);
    } catch (e) {
      if (e instanceof PdfStatementError) throw new StatementFormatError(e.message);
      throw e;
    }
  }
  throw new StatementFormatError("Upload a PDF, .csv or .xlsx statement.");
}

/** Parses a statement and feeds every row through the same ledger pipeline as email alerts. The file is not stored. */
export async function importStatement(
  userId: string,
  file: { name: string; bytes: Buffer },
  /** Fallbacks used only when the statement itself does not say which bank or currency it is. */
  opts: { institution?: string; currency?: string; password?: string } = {},
): Promise<StatementImportSummary> {
  if (file.bytes.length > MAX_STATEMENT_BYTES) throw new StatementFormatError("File is larger than 5 MB.");
  // The PDF password is used only to open the file in memory. It is never stored or logged.
  const sections = await readSections(file.name, file.bytes, opts.password);
  if (!sections.length) throw new StatementFormatError("No statement table found in this file.");
  const allFooter = sections.map((x) => x.otherText ?? "").join("\n");
  const summaries: StatementImportSummary[] = [];
  for (const section of sections) {
    const size = section.direct ? section.direct.transactions.length + section.direct.errors.length : section.rows.length;
    if (size > MAX_ROWS) throw new StatementFormatError(`Statement has more than ${MAX_ROWS.toLocaleString()} rows. Split it by date range.`);
    if (section.direct) {
      summaries.push(await persistParsed(userId, section.direct, {
        institution: section.institution ?? opts.institution ?? "Unknown bank",
        currency: section.currency ?? opts.currency ?? "NGN",
        fileName: file.name,
      }));
      continue;
    }
    const meta = detectStatementMeta(section.rows, file.name, allFooter);
    summaries.push(await importRows(userId, section.rows, {
      institution: meta.institution ?? opts.institution ?? "Unknown bank",
      currency: meta.currency ?? opts.currency ?? "NGN",
      fileName: file.name,
    }));
  }
  const linked = await pairOwnTransfers(userId);
  if (linked) {
    const last = await db.syncRun.findFirst({ where: { userId }, orderBy: { startedAt: "desc" } });
    if (last) await db.syncRun.update({ where: { id: last.id }, data: { linked } });
  }
  const [first, ...others] = summaries;
  return others.length ? { ...first, others } : first;
}

async function importRows(userId: string, rows: Cell[][], meta: { institution: string; currency: string; fileName: string }): Promise<StatementImportSummary> {
  return persistParsed(userId, parseStatementRows(rows, { institution: meta.institution, currency: meta.currency }), meta);
}

async function persistParsed(userId: string, parsed: StatementParseResult, { institution, currency, fileName }: { institution: string; currency: string; fileName: string }): Promise<StatementImportSummary> {
  const conn = await db.financialConnection.upsert({
    where: { userId_provider: { userId, provider: "statement" } },
    update: { status: "active" },
    create: { userId, provider: "statement", providerAccountId: "Statement uploads" },
  });
  const label = `${fileName} · ${institution}${parsed.accountLast4 ? ` ••${parsed.accountLast4}` : ""}`;
  const run = await db.syncRun.create({ data: { userId, connectionId: conn.id, status: "running", label: label.slice(0, 160) } });

  let created = 0;
  let duplicates = 0;
  let accountId: string | undefined;
  const rules = await loadUserRules(userId);
  const owners = [...(await loadOwners(userId)), ...(parsed.holder ? [parsed.holder] : [])];
  for (const tx of parsed.transactions) {
    const r = await ingestTransaction(userId, tx, rules, owners);
    if (r.status === "created") created++;
    else duplicates++;
    accountId ??= (await db.transaction.findUnique({ where: { id: r.transactionId }, select: { accountId: true } }))?.accountId;
  }

  // Nothing is silently dropped: every unreadable row is kept for the user to add or dismiss.
  if (parsed.errors.length) {
    await db.importIssue.createMany({
      data: parsed.errors.map((e) => ({
        userId, syncRunId: run.id, fileLabel: label.slice(0, 160), rowNumber: e.row, reason: e.reason, rawText: e.raw ?? "", accountId,
      })),
    });
  }
  // Self-check against the statement's own running balance.
  const rec = reconcile(parsed.transactions);
  const complete = parsed.errors.length === 0 && rec.breaks === 0;
  const status = !parsed.transactions.length && parsed.errors.length ? "failed" : complete ? "success" : "partial";

  await db.syncRun.update({
    where: { id: run.id },
    data: {
      status,
      balanceBreaks: rec.breaks,
      gapMinor: rec.breaks ? rec.gapMinor : null,
      finishedAt: new Date(),
      emailsScanned: parsed.rowsRead,
      parsed: parsed.transactions.length,
      created,
      duplicates,
      parseFailures: parsed.errors.length,
      error: parsed.transactions.length ? null : parsed.errors[0]?.reason ?? null,
    },
  });
  await db.financialConnection.update({ where: { id: conn.id }, data: { lastSyncedAt: new Date() } });
  log.info("statement.imported", { userId, rows: parsed.rowsRead, created, duplicates, failures: parsed.errors.length });
  return {
    institution, currency, rowsRead: parsed.rowsRead, created, duplicates, errors: parsed.errors, accountLast4: parsed.accountLast4,
    balanceBreaks: rec.breaks, gap: rec.breaks ? formatMoney(rec.gapMinor) : null, complete,
  };
}

/** Records a file that could not be imported at all, so the result banner can explain it. */
export async function recordFailedImport(userId: string, fileName: string, reason: string) {
  const conn = await db.financialConnection.upsert({
    where: { userId_provider: { userId, provider: "statement" } },
    update: {},
    create: { userId, provider: "statement", providerAccountId: "Statement uploads" },
  });
  await db.syncRun.create({
    data: { userId, connectionId: conn.id, status: "failed", finishedAt: new Date(), error: reason.slice(0, 300), label: fileName.slice(0, 160) },
  });
}

/** Statement imports from the last 15 minutes the user hasn't dismissed. */
export async function recentImportResults(userId: string) {
  return db.syncRun.findMany({
    where: { userId, seenAt: null, startedAt: { gte: new Date(Date.now() - 15 * 60_000) }, connection: { provider: "statement" } },
    orderBy: { startedAt: "asc" },
  });
}

export async function openIssues(userId: string) {
  return db.importIssue.findMany({ where: { userId, status: "open" }, orderBy: [{ createdAt: "desc" }, { rowNumber: "asc" }] });
}

/** Best-effort prefill for fixing a skipped row: the date, amount and words found in its original text. */
export function guessFromRaw(raw: string): { date?: string; amount?: string; description: string } {
  const cells = raw.split(" | ").map((c) => c.trim()).filter(Boolean);
  const date = cells.map((c) => parseBankDate(c)).find((d): d is Date => !!d);
  const amounts = cells.map((c) => moneyCell(c)).filter((m): m is bigint => m !== null && m !== 0n);
  const words = cells.filter((c) => /[A-Za-z]{3,}/.test(c) && !parseBankDate(c)).sort((a, b) => b.length - a.length);
  return {
    date: date ? new Date(date.getTime() + 3600_000).toISOString().slice(0, 10) : undefined,
    // The first amount is the transaction; a later one is usually the running balance.
    amount: amounts[0] !== undefined ? (Number(amounts[0] < 0n ? -amounts[0] : amounts[0]) / 100).toFixed(2) : undefined,
    description: words[0] ?? raw.slice(0, 80),
  };
}

/** Adds a skipped row to the ledger with the user's confirmed values. */
export async function resolveIssueByAdding(
  userId: string,
  issueId: string,
  input: { date: string; direction: "in" | "out"; amount: string; description: string },
) {
  const issue = await db.importIssue.findFirst({ where: { id: issueId, userId, status: "open" } });
  if (!issue) throw new StatementFormatError("This item was already resolved.");
  const amountMinor = parseAmountToMinor(input.amount);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? new Date(`${input.date}T12:00:00+01:00`) : undefined;
  if (!amountMinor || amountMinor <= 0n || !date || isNaN(date.getTime())) throw new StatementFormatError("Enter a valid date and amount.");
  const account = issue.accountId ? await db.account.findFirst({ where: { id: issue.accountId, userId } }) : null;
  await ingestTransaction(userId, {
    institution: account?.institution ?? "Unknown bank",
    accountLast4: account?.maskedAccountNumber.replace(/\D/g, "") || undefined,
    source: "manual",
    sourceTransactionId: `issue:${issue.id}`,
    type: input.direction === "in" ? "CREDIT" : "DEBIT",
    amountMinor,
    currency: account?.currency ?? "NGN",
    transactionDate: date,
    description: input.description.trim().slice(0, 200) || issue.rawText.slice(0, 200),
    confidence: 1,
  });
  await db.importIssue.update({ where: { id: issue.id }, data: { status: "added", resolvedAt: new Date() } });
}

export async function resolveIssueByIgnoring(userId: string, issueId: string) {
  await db.importIssue.updateMany({ where: { id: issueId, userId, status: "open" }, data: { status: "ignored", resolvedAt: new Date() } });
}
