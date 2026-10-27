import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { detectStatementMeta, moneyCell, parseCsv, parseStatementRows } from "@/core/statements";
import { importStatement } from "@/core/statement-import";
import { syncEmailSource } from "@/core/ledger";
import { FixtureEmailSource } from "@/core/providers/fixture";

const SAMPLE = readFileSync("public/sample-gtbank-statement.csv");

describe("CSV and cell parsing", () => {
  it("handles quotes, embedded commas and CRLF", () => {
    expect(parseCsv('a,"b,c","d ""q"""\r\n1,2,3')).toEqual([["a", "b,c", 'd "q"'], ["1", "2", "3"]]);
  });

  it.each([
    ["1,234.50", 123_450n], ["₦1,234.50", 123_450n], ["(500.00)", -50_000n], ["-500", -50_000n],
    ["NGN 2,000", 200_000n], [1234.5, 123_450n], ["", null], ["-", null],
  ])("moneyCell(%s)", (v, expected) => {
    expect(moneyCell(v as string)).toBe(expected);
  });
});

describe("parseStatementRows", () => {
  it("finds the header below the preamble, reads the account number, skips balance rows", () => {
    const r = parseStatementRows(parseCsv(SAMPLE.toString()), { institution: "GTBank" });
    expect(r.accountLast4).toBe("4521");
    expect(r.rowsRead).toBe(7);
    expect(r.errors).toEqual([]);
    const salary = r.transactions.find((t) => t.description.includes("SALARY"))!;
    expect(salary).toMatchObject({ type: "CREDIT", amountMinor: 198_361_100n, reference: "090110260924150117002", balanceAfterMinor: 475_000_000n });
    expect(r.transactions.length).toBe(7);
    expect(r.transactions.find((t) => t.description.includes("SHOPRITE"))!.amountMinor).toBe(4_525_050n);
  });

  it("supports a single signed Amount column and Excel Date cells", () => {
    const rows = [
      ["Date", "Description", "Amount", "Balance"],
      [new Date(Date.UTC(2026, 8, 3)), "UBER TRIP", -4500, 100000],
      [new Date(Date.UTC(2026, 8, 4)), "REFUND JUMIA", 2000, 102000],
    ];
    const r = parseStatementRows(rows, { institution: "GTBank" });
    expect(r.transactions.map((t) => [t.type, t.amountMinor])).toEqual([["DEBIT", 450_000n], ["CREDIT", 200_000n]]);
    expect(r.transactions[0].transactionDate.toISOString().slice(0, 10)).toBe("2026-09-03");
  });

  it("carries a day's date down to rows printed without one, and joins balance-only lines", () => {
    const rows = [
      ["Date", "Transaction Details", "Amount", "Balance"],
      ["Jun 3, 2026", "Money transfer to ADA", "(94.01)", "509.49"],
      ["", "Money transfer to OBI", "(18.07)", "491.42"],
      ["", "", "", "350.41"],
      ["", "Money transfer to KHADRI", "(141.01)", ""],
      ["Jul 8, 2026", "", "", ""],
      ["", "PESAPEER INC / Payroll", "6,000.00", "6,350.41"],
    ];
    const r = parseStatementRows(rows, { institution: "Pesa", currency: "CAD" });
    expect(r.errors).toEqual([]);
    expect(r.transactions.map((t) => [t.transactionDate.toISOString().slice(0, 10), t.amountMinor, t.balanceAfterMinor])).toEqual([
      ["2026-06-03", 9401n, 50949n], ["2026-06-03", 1807n, 49142n], ["2026-06-03", 14101n, 35041n], ["2026-07-08", 600000n, 635041n],
    ]);
  });

  it("reports rows it cannot read instead of guessing", () => {
    const rows = [["Date", "Narration", "Debit", "Credit"], ["not a date", "X", "10", ""], ["01/09/2026", "Y", "", ""], ["02/09/2026", "Z", "N/A", ""], ["", "W", "500", ""]];
    const r = parseStatementRows(rows, { institution: "GTBank" });
    expect(r.errors.map((e) => e.reason)).toEqual(["Unreadable date", "No debit or credit amount", "Unreadable amount"]);
    // The blank-dated row takes the readable date above it, even though that row itself failed
    expect(r.transactions.map((t) => [t.description, t.transactionDate.toISOString().slice(0, 10)])).toEqual([["W", "2026-09-02"]]);
  });

  it("explains when no header row exists", () => {
    const r = parseStatementRows([["hello", "world"]], { institution: "GTBank" });
    expect(r.errors[0].reason).toMatch(/header row/);
  });

  it("captures a quoted payout rate on an unpaired USD wallet row", () => {
    const rows = [
      ["Date", "Transaction Details", "Amount", "Balance"],
      ["Oct 4, 2026", "USD wallet payout @ 1550 NGN / Guaranty Trust Bank", "(100.00)", "400.00"],
    ];
    const r = parseStatementRows(rows, { institution: "Pesa", currency: "USD" });
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({ fxQuoteCurrency: "NGN", fxQuoteMinor: 155_000_00n });
  });
});

describe("detectStatementMeta", () => {
  it("detects bank and currency from the preamble", () => {
    expect(detectStatementMeta(parseCsv(SAMPLE.toString()))).toEqual({ institution: "GTBank", currency: undefined });
    const kuda = [["Kuda Microfinance Bank"], ["Currency: NGN"], ["Date", "Description", "Money In", "Money Out", "Balance"]];
    expect(detectStatementMeta(kuda)).toEqual({ institution: "Kuda", currency: "NGN" });
    const dom = [["Zenith Bank Plc Domiciliary Account"], ["Date", "Narration", "Debit", "Credit"]];
    expect(detectStatementMeta(dom)).toEqual({ institution: "Zenith Bank", currency: "USD" });
  });

  it("uses the bank named most in footer text, ignoring banks named in narrations", () => {
    const rows = [["Date", "Narration", "Debit", "Credit"], ["01/09/2026", "TRANSFER TO FCMB JOHN", "10", ""]];
    const footer = "Please address all enquiries to Guaranty Trust Bank Ltd\nGuaranty Trust Bank Ltd is regulated\nTRANSFER TO FCMB";
    expect(detectStatementMeta(rows, "214R0054.pdf", footer).institution).toBe("GTBank");
    expect(detectStatementMeta(rows, "214R0054.pdf").institution).toBeUndefined();
  });

  it("falls back to the file name", () => {
    expect(detectStatementMeta([["Date", "Narration", "Debit", "Credit"]], "access-bank-aug.csv").institution).toBe("Access Bank");
  });

  it("reads a Pesa CAD wallet id even when the amount column is labelled $", () => {
    const cad = [["Pesa Account Statement"], ["Wallet: CAOO123456789"], ["Date", "Transaction Details", "Amount", "Balance"]];
    expect(detectStatementMeta(cad)).toEqual({ institution: "Pesa", currency: "CAD" });
    const usd = [["Pesa Account Statement"], ["Wallet: USOO123456789"], ["Date", "Transaction Details", "Amount", "Balance"]];
    expect(detectStatementMeta(usd)).toEqual({ institution: "Pesa", currency: "USD" });
  });
});

describe("importStatement", () => {
  let userId: string;
  beforeAll(async () => {
    userId = (await db.user.create({ data: { email: "stmt@test.dev" } })).id;
  });

  it("imports a fresh statement, then is idempotent on re-upload", async () => {
    const first = await importStatement(userId, { name: "s.csv", bytes: SAMPLE }, { institution: "GTBank" });
    expect(first).toMatchObject({ rowsRead: 7, created: 7, duplicates: 0 });
    const again = await importStatement(userId, { name: "s.csv", bytes: SAMPLE }, { institution: "GTBank" });
    expect(again).toMatchObject({ created: 0, duplicates: 7 });
    expect(await db.transaction.count({ where: { userId } })).toBe(7);
  });

  it("merges statement rows with the same transactions already ingested from email alerts", async () => {
    const u = await db.user.create({ data: { email: "stmt-merge@test.dev" } });
    const conn = await db.financialConnection.create({ data: { userId: u.id, provider: "fixture", lastSyncedAt: new Date("2026-01-01") } });
    await syncEmailSource(u.id, conn.id, new FixtureEmailSource());
    const before = await db.transaction.count({ where: { userId: u.id } });
    const r = await importStatement(u.id, { name: "s.csv", bytes: SAMPLE }, { institution: "GTBank" });
    // Shoprite, Bolt, salary and rent were already seen as alerts; Chowdeck, MTN and ATM are new
    expect(r).toMatchObject({ created: 3, duplicates: 4 });
    expect(await db.transaction.count({ where: { userId: u.id } })).toBe(before + 3);
    const rent = await db.transaction.findFirstOrThrow({ where: { userId: u.id, reference: "000013260925101452001" }, include: { sources: true } });
    expect(rent.sources.map((s) => s.source)).toContain("statement");
  });

  it("keeps accounts from different banks apart", async () => {
    const u = await db.user.create({ data: { email: "multi@test.dev" } });
    const kuda = Buffer.from("Kuda Microfinance Bank\nAccount Number,2001119876\nDate,Description,Money Out,Money In,Balance\n03/09/2026,UBER TRIP,4500,,95500\n");
    await importStatement(u.id, { name: "gtb.csv", bytes: SAMPLE });
    const r = await importStatement(u.id, { name: "kuda.csv", bytes: kuda });
    expect(r).toMatchObject({ institution: "Kuda", created: 1 });
    const accts = await db.account.findMany({ where: { userId: u.id }, orderBy: { institution: "asc" } });
    expect(accts.map((a) => `${a.institution} ${a.maskedAccountNumber}`)).toEqual(["GTBank ****4521", "Kuda ****9876"]);
  });

  it("rejects unsupported formats with a helpful message", async () => {
    await expect(importStatement(userId, { name: "s.pdf", bytes: Buffer.from("x") }, { institution: "GTBank" })).rejects.toThrow(/PDF/);
    await expect(importStatement(userId, { name: "s.xls", bytes: Buffer.from("x") }, { institution: "GTBank" })).rejects.toThrow(/xlsx/);
  });
});

describe("overlapping statements for the same account (from a real audit)", () => {
  it("merges a masked-number statement with a full-number one and does not duplicate rows", async () => {
    const u = await db.user.create({ data: { email: "masked@test.dev" } });
    const full = Buffer.from([
      "Account No.,000XXXX533", "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
      "24-Sep-2026,REF0001,1000.00,,9000.00,TRANSFER TO KEMI",
      "24-Sep-2026,'GTW,.75,,8999.25,VAT CHARGES",
      "25-Sep-2026,REF0003,,500.00,9499.25,NIP FROM TOLU",
    ].join("\n"));
    const partial = Buffer.from([
      "Account No,0001234533", "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
      "24-Sep-2026,REF0001,1000.00,,9000.00,TRANSFER TO KEMI ADEBAYO",
      "24-Sep-2026,,0.75,,8999.25,VATCHARGES",
    ].join("\n"));
    const a = await importStatement(u.id, { name: "full.csv", bytes: full }, { institution: "GTBank" });
    const b = await importStatement(u.id, { name: "partial.csv", bytes: partial }, { institution: "GTBank" });
    expect(a).toMatchObject({ accountLast4: "533", created: 3 });
    expect(b).toMatchObject({ accountLast4: "4533", created: 0, duplicates: 2 });
    const accts = await db.account.findMany({ where: { userId: u.id } });
    expect(accts.map((x) => x.maskedAccountNumber)).toEqual(["****4533"]);
    expect(await db.transaction.count({ where: { userId: u.id } })).toBe(3);
  });

  it("still keeps two genuine identical purchases apart (different running balances)", async () => {
    const u = await db.user.create({ data: { email: "twins@test.dev" } });
    const csv = Buffer.from(["Date,Description,Debit,Credit,Balance", "03/09/2026,UBER TRIP,4500,,95500", "03/09/2026,UBER TRIP,4500,,91000"].join("\n"));
    expect(await importStatement(u.id, { name: "s.csv", bytes: csv }, { institution: "GTBank" })).toMatchObject({ created: 2 });
  });
});

describe("import status records", () => {
  it("keeps a labelled result per file and records failures, until dismissed", async () => {
    const { recentImportResults, recordFailedImport } = await import("@/core/statement-import");
    const u = await db.user.create({ data: { email: "status@test.dev" } });
    await importStatement(u.id, { name: "gtb.csv", bytes: SAMPLE });
    await recordFailedImport(u.id, "old.xls", "Old .xls files are not supported.");
    const runs = await recentImportResults(u.id);
    expect(runs.map((r) => [r.label, r.status])).toEqual([["gtb.csv · GTBank ••4521", "success"], ["old.xls", "failed"]]);
    expect(runs[0]).toMatchObject({ created: 7, duplicates: 0 });
    await db.syncRun.updateMany({ where: { userId: u.id }, data: { seenAt: new Date() } });
    expect(await recentImportResults(u.id)).toHaveLength(0);
  });
});
