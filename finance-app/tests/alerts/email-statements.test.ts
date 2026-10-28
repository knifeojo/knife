import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { importEmailAttachments, unlockStatement } from "@/core/alerts/import-statements";
import { POST as inbound } from "@/app/api/inbound/email/route";
import { syncEmailSource } from "@/core/ledger";
import { FixtureEmailSource } from "@/core/providers/fixture";
import { importStatement } from "@/core/statement-import";
import { periodOverlap, statementFileStatus } from "@/core/statements/files";
import { reconcileAlertsVsStatement } from "@/core/alerts/reconcile";
import { backfillStatementFiles } from "@/core/statements/backfill";
import { passwordsForInstitution, pendingStatementDir, saveStatementPassword } from "@/core/statements/passwords";
import { ingestTransaction } from "@/core/ledger";
import { makePesaPdf } from "../fixtures/pesa-pdf";

const previousPasswordFile = process.env.STATEMENT_PASSWORD_FILE;
const previousPendingDir = process.env.STATEMENT_PENDING_DIR;
const passwordDir = mkdtempSync(join(tmpdir(), "stmt-pw-"));
const passwordFile = join(passwordDir, "passwords.json");
process.env.STATEMENT_PASSWORD_FILE = passwordFile;
process.env.STATEMENT_PENDING_DIR = join(passwordDir, "pending");

afterAll(() => {
  if (previousPasswordFile === undefined) delete process.env.STATEMENT_PASSWORD_FILE;
  else process.env.STATEMENT_PASSWORD_FILE = previousPasswordFile;
  if (previousPendingDir === undefined) delete process.env.STATEMENT_PENDING_DIR;
  else process.env.STATEMENT_PENDING_DIR = previousPendingDir;
});

const PDF_PASSWORD = "test1234";

function csv(rows: string[]): Buffer {
  return Buffer.from(
    [
      "Guaranty Trust Bank",
      "Account No,0123499911",
      "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
      ...rows,
    ].join("\n"),
  );
}

const SEPTEMBER = csv([
  "01-Sep-2026,SYN1,1500.00,,8500.00,TRANSFER TO ADA OKAFOR",
  "02-Sep-2026,SYN2,,2000.00,10500.00,SALARY FROM ACME",
]);
const SEPTEMBER_AGAIN = Buffer.concat([SEPTEMBER, Buffer.from("\n")]);
const OCTOBER_EXTRA = csv([
  "01-Sep-2026,SYN1,1500.00,,8500.00,TRANSFER TO ADA OKAFOR",
  "02-Sep-2026,SYN2,,2000.00,10500.00,SALARY FROM ACME",
  "03-Sep-2026,SYN3,500.00,,10000.00,POS SHOP",
]);
const ONLY_FIRST = csv(["01-Sep-2026,SYN1,1500.00,,8500.00,TRANSFER TO ADA OKAFOR"]);

function statementEmail(bytes: Buffer, filename = "e-statement.csv") {
  return {
    source: "gmail",
    messageId: `msg-${filename}-${bytes.length}`,
    from: "Statements <statements@gtbank.com>",
    subject: "Your e-statement",
    attachments: [{ filename, mimeType: "text/csv", bytes }],
  };
}

describe("period overlap", () => {
  const sep1 = new Date("2026-09-01T00:00:00Z");
  const sep30 = new Date("2026-09-30T00:00:00Z");
  const oct31 = new Date("2026-10-31T00:00:00Z");
  const sep15 = new Date("2026-09-15T00:00:00Z");

  it("classifies contained, partial and separate periods", () => {
    expect(periodOverlap(sep15, sep15, sep1, sep30)).toBe("contained");
    expect(periodOverlap(sep15, oct31, sep1, sep30)).toBe("overlap");
    expect(periodOverlap(oct31, oct31, sep1, sep30)).toBe("none");
    expect(statementFileStatus({ created: 0, overlap: "contained" })).toBe("duplicate");
    expect(statementFileStatus({ created: 2, overlap: "overlap" })).toBe("imported");
    expect(statementFileStatus({ created: 0, overlap: "none" })).toBe("imported");
  });
});

describe("email statement import", () => {
  it("imports a CSV attachment once, then treats the same bytes and an overlapping file as duplicates", async () => {
    const user = await db.user.create({ data: { email: "stmt-mail@test.dev" } });
    const first = await importEmailAttachments(user.id, statementEmail(SEPTEMBER));
    expect(first).toEqual([expect.objectContaining({ file: "e-statement.csv", status: "imported", institution: "GTBank", created: 2 })]);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(2);

    const again = await importEmailAttachments(user.id, statementEmail(SEPTEMBER, "e-statement.csv"));
    expect(again[0].status).toBe("duplicate");
    expect(again[0].created).toBe(0);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(2);

    const uploaded = await importStatement(user.id, { name: "manual.csv", bytes: SEPTEMBER });
    expect(uploaded.fileStatus).toBe("duplicate");
    expect(uploaded.created).toBe(0);
    expect(uploaded.duplicates).toBe(2);

    const shifted = await importEmailAttachments(user.id, statementEmail(SEPTEMBER_AGAIN, "copy.csv"));
    expect(shifted[0].status).toBe("duplicate");
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(2);

    const extended = await importEmailAttachments(user.id, statementEmail(OCTOBER_EXTRA, "longer.csv"));
    expect(extended[0].status).toBe("imported");
    expect(extended[0].created).toBe(1);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(3);

    const subset = await importEmailAttachments(user.id, statementEmail(ONLY_FIRST, "subset.csv"));
    expect(subset[0].status).toBe("duplicate");
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(3);

    const row = await db.statementFile.findFirstOrThrow({ where: { userId: user.id, fileName: "e-statement.csv" } });
    expect(row.status).toBe("duplicate");
    expect(row.occurrences).toBeGreaterThan(1);
    expect(row.bytesStored).toBe(false);
  });

  it("does not import an ordinary alert attachment", async () => {
    const user = await db.user.create({ data: { email: "stmt-alert@test.dev" } });
    const result = await importEmailAttachments(user.id, {
      source: "gmail",
      messageId: "alert-1",
      from: "GeNS <gens@gtbank.com>",
      subject: "GeNS Transaction Alert [Debit]",
      attachments: [{ filename: "logo.png", mimeType: "image/png", bytes: Buffer.from("png") }],
    });
    expect(result).toEqual([]);
    expect(await db.statementFile.count({ where: { userId: user.id } })).toBe(0);
  });

  it("queues a locked PDF, opens it from Review, and can remember the password without logging or uploading it", async () => {
    const user = await db.user.create({ data: { email: "stmt-lock@test.dev" } });
    const enc = readFileSync("tests/fixtures/encrypted-statement.pdf");
    const info = vi.spyOn(log, "info");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const queued = await importEmailAttachments(user.id, {
      source: "imap",
      messageId: "locked-1",
      from: "Statements <statements@gtbank.com>",
      subject: "Your e-statement",
      attachments: [{ filename: "e-statement.pdf", mimeType: "application/pdf", bytes: enc }],
    });
    expect(queued[0].status).toBe("needs_password");
    const row = await db.statementFile.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.status).toBe("needs_password");
    expect(row.bytesStored).toBe(true);
    expect(JSON.stringify(row)).not.toContain(PDF_PASSWORD);
    const sealed = readFileSync(join(pendingStatementDir(), user.id, row.contentHash), "utf8");
    expect(sealed).not.toContain(PDF_PASSWORD);
    expect(sealed).not.toContain(enc.toString("base64").slice(0, 40));
    expect(existsSync(passwordFile) && readFileSync(passwordFile, "utf8").includes(PDF_PASSWORD)).toBe(false);

    const wrong = await unlockStatement(user.id, row.id, "not-the-password");
    expect(wrong).toEqual({ error: "That password did not open the statement." });
    expect((await db.statementFile.findFirstOrThrow({ where: { id: row.id } })).status).toBe("needs_password");
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(0);

    const opened = await unlockStatement(user.id, row.id, PDF_PASSWORD, { remember: true });
    expect(opened).toMatchObject({ ok: true, summary: { created: 4, institution: "GTBank" } });
    expect((await db.statementFile.findFirstOrThrow({ where: { id: row.id } })).status).toBe("imported");
    expect((await db.statementFile.findFirstOrThrow({ where: { id: row.id } })).bytesStored).toBe(false);
    expect(existsSync(join(pendingStatementDir(), user.id, row.contentHash))).toBe(false);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(4);

    const stored = readFileSync(passwordFile, "utf8");
    expect(stored).not.toContain(PDF_PASSWORD);
    expect(passwordsForInstitution(user.id, "GTBank")).toEqual([PDF_PASSWORD]);
    expect(JSON.stringify(info.mock.calls)).not.toContain(PDF_PASSWORD);
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain(PDF_PASSWORD);
    info.mockRestore();
    fetchSpy.mockRestore();

    const other = await db.user.create({ data: { email: "stmt-saved@test.dev" } });
    saveStatementPassword(other.id, "GTBank", PDF_PASSWORD);
    const viaSaved = await importStatement(other.id, { name: "e-statement.pdf", bytes: enc }, { institution: "GTBank" });
    expect(viaSaved.created).toBe(4);
    expect(readFileSync(passwordFile, "utf8")).not.toContain(PDF_PASSWORD);

    const wrongSaved = await db.user.create({ data: { email: "stmt-wrong-saved@test.dev" } });
    saveStatementPassword(wrongSaved.id, "GTBank", "not-the-password");
    await expect(importStatement(wrongSaved.id, { name: "e-statement.pdf", bytes: enc }, { institution: "GTBank" })).rejects.toThrow(/password/i);
    expect(await db.transaction.count({ where: { userId: wrongSaved.id } })).toBe(0);
    expect(readFileSync(passwordFile, "utf8")).not.toContain("not-the-password");
  });

  it("marks an unreadable attachment as an unrecognised layout", async () => {
    const user = await db.user.create({ data: { email: "stmt-bad@test.dev" } });
    const result = await importEmailAttachments(user.id, {
      source: "inbound",
      messageId: "bad-1",
      from: "statements@firstbanknigeria.com",
      subject: "Account statement",
      attachments: [{ filename: "statement.pdf", mimeType: "application/pdf", bytes: Buffer.from("not a pdf") }],
    });
    expect(result[0].status).toBe("unrecognised");
    const row = await db.statementFile.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.status).toBe("unrecognised");
    expect(row.bytesStored).toBe(false);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(0);
  });

  it("imports a statement during mailbox sync and does not import it again on the next sync", async () => {
    const user = await db.user.create({ data: { email: "stmt-sync@test.dev" } });
    const conn = await db.financialConnection.create({ data: { userId: user.id, provider: "fixture", lastSyncedAt: new Date("2026-01-01") } });
    const source = new FixtureEmailSource([
      {
        id: "fix-stmt-1",
        from: "Statements <statements@sterling.ng>",
        subject: "Your account statement",
        date: new Date("2026-09-03T12:00:00Z"),
        text: "Please find your statement attached.",
        attachments: [{ filename: "account-statement.csv", mimeType: "text/csv", bytes: SEPTEMBER }],
      },
    ]);
    const first = await syncEmailSource(user.id, conn.id, source);
    expect(first.emailsScanned).toBe(1);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(2);
    const second = await syncEmailSource(user.id, conn.id, source);
    expect(second.emailsScanned).toBe(0);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(2);
    expect(await db.statementFile.findFirst({ where: { userId: user.id } })).toMatchObject({ status: "imported", source: "fixture" });
  });
});

describe("forwarding inbox imports the attachment", () => {
  it("posts a Postmark statement into the ledger", async () => {
    process.env.INBOUND_EMAIL_SECRET = "stmt-inbound-secret";
    const user = await db.user.create({ data: { email: "stmt-in@test.dev", inboundEmailToken: "stmtTok12345678" } });
    const res = await inbound(new Request("http://localhost/api/inbound/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-inbound-secret": "stmt-inbound-secret" },
      body: JSON.stringify({
        To: "alerts-stmtTok12345678@x.test",
        From: "Statements <statements@providusbank.com>",
        Subject: "Account statement",
        TextBody: "Attached",
        MessageID: "pm-stmt-1",
        Attachments: [{ Name: "account-statement.csv", ContentType: "text/csv", Content: SEPTEMBER.toString("base64") }],
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statements[0]).toMatchObject({ status: "imported", created: 2 });
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(2);
    const second = await inbound(new Request("http://localhost/api/inbound/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-inbound-secret": "stmt-inbound-secret" },
      body: JSON.stringify({
        To: "alerts-stmtTok12345678@x.test",
        From: "Statements <statements@providusbank.com>",
        Subject: "Account statement",
        TextBody: "Attached again",
        MessageID: "pm-stmt-2",
        Attachments: [{ Name: "account-statement.csv", ContentType: "text/csv", Content: SEPTEMBER.toString("base64") }],
      }),
    }));
    const again = await second.json();
    expect(again.statements[0].status).toBe("duplicate");
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(2);
  });
});

describe("re-import does not change the ledger", () => {
  it("re-imports a multi-currency wallet statement as zero new rows when a CAD row was stored under USD", async () => {
    const user = await db.user.create({ data: { email: "stmt-cad@test.dev" } });
    const pdf = await makePesaPdf();
    const first = await importStatement(user.id, { name: "wallet.pdf", bytes: pdf });
    expect(first.created).toBeGreaterThan(0);
    const before = await db.transaction.count({ where: { userId: user.id } });
    const cad = await db.transaction.findFirstOrThrow({ where: { userId: user.id, currency: "CAD" } });
    await db.statementFile.deleteMany({ where: { userId: user.id } });
    await db.transactionSource.updateMany({ where: { transactionId: cad.id }, data: { sourceTransactionId: "old-cad-source" } });
    await db.transaction.update({
      where: { id: cad.id },
      data: {
        currency: "USD",
        sourceTransactionId: "old-cad-source",
        fingerprint: "old-cad-fingerprint",
        // 23:30 UTC is the next Lagos morning, the shift a UTC-midnight reading makes.
        transactionDate: new Date("2025-10-28T23:30:00.000Z"),
        balanceAfterMinor: cad.balanceAfterMinor,
      },
    });
    const again = await importStatement(user.id, { name: "wallet-reread.pdf", bytes: pdf });
    expect(again.created).toBe(0);
    expect(again.fileStatus).toBe("duplicate");
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(before);
  });

  it("keeps totals, transfer pairs and flags unchanged for the same file and an overlap", async () => {
    const user = await db.user.create({ data: { email: "stmt-e2e@test.dev" } });
    const csv = Buffer.from([
      "Guaranty Trust Bank",
      "Account No,0123499911",
      "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
      "01-Nov-2025,OLD1,1000.00,,9000.00,TRANSFER TO ADA OKAFOR",
      "15-Mar-2026,MID1,2000.00,,7000.00,SHOPRITE LEKKI",
      "01-May-2026,NEW1,,5000.00,12000.00,SALARY FROM ACME",
      "03-Sep-2026,A2,100000.00,,900000.00,Instant Payment Outward 01 X FROM EZE SEUN SAMUEL TO KUDA - EZE SEUN SAMUEL",
    ].join("\n"));
    const kuda = Buffer.from([
      "Kuda Microfinance Bank",
      "Account Number,2001119876",
      "Date,Description,Money Out,Money In,Balance",
      "03/09/2026,TRANSFER FROM EZE SEUN SAMUEL,,100000,100000",
    ].join("\n"));
    const overlap = Buffer.from([
      "Guaranty Trust Bank",
      "Account No,0123499911",
      "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
      "15-Mar-2026,MID1,2000.00,,7000.00,SHOPRITE LEKKI",
      "01-May-2026,NEW1,,5000.00,12000.00,SALARY FROM ACME",
      "",
    ].join("\n"));
    await importStatement(user.id, { name: "gtb.csv", bytes: csv });
    await importStatement(user.id, { name: "kuda.csv", bytes: kuda });
    await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "sms",
      sourceTransactionId: "sms-old",
      type: "DEBIT",
      amountMinor: 50_000n,
      currency: "NGN",
      transactionDate: new Date("2026-03-15T18:00:00Z"),
      description: "POS DIFFERENT SHOP",
      accountLast4: "9911",
      confidence: 1,
    });

    const snapshot = async () => {
      const rows = await db.transaction.findMany({
        where: { userId: user.id },
        select: { id: true, type: true, amountMinor: true, currency: true, transferPairId: true, description: true },
      });
      const inflow = rows.filter((row) => row.type === "CREDIT").reduce((sum, row) => sum + row.amountMinor, 0n);
      const outflow = rows.filter((row) => row.type === "DEBIT").reduce((sum, row) => sum + row.amountMinor, 0n);
      const pairs = rows.map((row) => row.transferPairId ?? "").sort();
      const flags = await db.reconFlag.count({ where: { userId: user.id } });
      return { count: rows.length, inflow, outflow, pairs, flags };
    };
    const account = await db.account.findFirstOrThrow({ where: { userId: user.id, institution: "GTBank" } });
    await reconcileAlertsVsStatement(user.id, account.id, new Date("2025-11-01T00:00:00Z"), new Date("2026-09-30T00:00:00Z"));
    const early = await db.transaction.findFirstOrThrow({ where: { userId: user.id, reference: "OLD1" } });
    const later = await db.transaction.findFirstOrThrow({ where: { userId: user.id, reference: "NEW1" } });
    expect(await db.reconFlag.findFirst({ where: { userId: user.id, transactionId: early.id } })).toBeNull();
    expect(await db.reconFlag.findFirst({ where: { userId: user.id, transactionId: later.id, kind: "statement_without_alert" } })).not.toBeNull();
    const before = await snapshot();

    await db.statementFile.deleteMany({ where: { userId: user.id } });
    const filled = await backfillStatementFiles();
    expect(filled.created).toBeGreaterThan(0);
    const again = await backfillStatementFiles();
    expect(again.created).toBe(0);

    const same = await importEmailAttachments(user.id, statementEmail(csv, "gtb.csv"));
    expect(same[0].status).toBe("duplicate");
    expect(same[0].created).toBe(0);
    const overlapped = await importEmailAttachments(user.id, {
      ...statementEmail(overlap, "overlap.csv"),
      messageId: "overlap-1",
    });
    expect(overlapped[0].status).toBe("duplicate");
    expect(overlapped[0].created).toBe(0);
    expect(await snapshot()).toEqual(before);
  });
});

describe("statements without a running balance", () => {
  function noBalance(lines: string[]): Buffer {
    return Buffer.from(["Date,Description,Amount", ...lines].join("\n"));
  }

  it("does not merge different narrations that share an amount and a day", async () => {
    const user = await db.user.create({ data: { email: "stmt-nobal-diff@test.dev" } });
    const file = noBalance([
      "05/03/2026,Deel advance fee,25.00",
      "05/03/2026,Deel card withdrawal,25.00",
    ]);
    const imported = await importStatement(user.id, { name: "deel.csv", bytes: file }, { institution: "Deel", currency: "USD" });
    expect(imported.created).toBe(2);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(2);
  });

  it("keeps identical no-balance rows as a multiset", async () => {
    const user = await db.user.create({ data: { email: "stmt-nobal-multi@test.dev" } });
    const one = noBalance(["05/03/2026,Deel advance fee,25.00"]);
    const two = noBalance([
      "05/03/2026,Deel advance fee,25.00",
      "05/03/2026,Deel advance fee,25.00",
    ]);
    expect((await importStatement(user.id, { name: "one.csv", bytes: one }, { institution: "Deel", currency: "USD" })).created).toBe(1);
    await db.statementFile.deleteMany({ where: { userId: user.id } });
    const second = await importStatement(user.id, { name: "two.csv", bytes: two }, { institution: "Deel", currency: "USD" });
    expect(second.created).toBe(1);
    expect(second.duplicates).toBe(1);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(2);
    await db.statementFile.deleteMany({ where: { userId: user.id } });
    const again = await importStatement(user.id, { name: "two-again.csv", bytes: two }, { institution: "Deel", currency: "USD" });
    expect(again.created).toBe(0);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(2);
  });
});

describe("import scope and a corrupt password file", () => {
  it("imports a CSV while the password file is corrupt, and reports that only on a locked PDF", async () => {
    const junk = "{not json";
    writeFileSync(passwordFile, junk);
    try {
      const user = await db.user.create({ data: { email: "stmt-corrupt-csv@test.dev" } });
      const csv = Buffer.from([
        "Guaranty Trust Bank",
        "Account No,0123499911",
        "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
        "02-Sep-2026,SYN9,1500.00,,8500.00,TRANSFER TO ADA OKAFOR",
      ].join("\n"));
      const imported = await importStatement(user.id, { name: "open.csv", bytes: csv });
      expect(imported.created).toBe(1);
      await expect(importStatement(user.id, { name: "locked.pdf", bytes: readFileSync("tests/fixtures/encrypted-statement.pdf") })).rejects.toThrow(/corrupt/);
      expect(readFileSync(passwordFile, "utf8")).toBe(junk);
      expect(await db.transaction.count({ where: { userId: user.id } })).toBe(1);
    } finally {
      writeFileSync(passwordFile, JSON.stringify({ version: 1, entries: [] }));
    }
  });

  it("extends statement coverage instead of replacing it when the account has no alerts", async () => {
    const user = await db.user.create({ data: { email: "stmt-cover@test.dev" } });
    const account = await db.account.create({
      data: {
        userId: user.id,
        institution: "GTBank",
        accountName: "GTBank",
        maskedAccountNumber: "****9911",
        currency: "NGN",
        statementCoveredFrom: new Date("2026-01-01T00:00:00Z"),
        statementCoveredTo: new Date("2026-12-31T00:00:00Z"),
      },
    });
    await reconcileAlertsVsStatement(user.id, account.id, new Date("2026-03-01T00:00:00Z"), new Date("2026-03-31T00:00:00Z"));
    const after = await db.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.statementCoveredFrom?.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(after.statementCoveredTo?.toISOString().slice(0, 10)).toBe("2026-12-31");
  });

  it("does not reconcile another account when importing this one", async () => {
    const user = await db.user.create({ data: { email: "stmt-scope@test.dev" } });
    const other = await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTBank", maskedAccountNumber: "****1111", currency: "NGN" },
    });
    await db.transaction.create({
      data: {
        userId: user.id, accountId: other.id, source: "statement", sourceTransactionId: "old-stmt", fingerprint: "old-stmt-fp",
        transactionDate: new Date("2024-06-01T11:00:00Z"), type: "DEBIT", amountMinor: 5_000n, currency: "NGN",
        description: "OLD SHOP", category: "Other", classificationSource: "rule", classificationConfidence: 1,
      },
    });
    await db.transaction.create({
      data: {
        userId: user.id, accountId: other.id, source: "sms", sourceTransactionId: "old-sms", fingerprint: "old-sms-fp",
        transactionDate: new Date("2024-06-02T11:00:00Z"), type: "DEBIT", amountMinor: 9_000n, currency: "NGN",
        description: "OLD ALERT", category: "Other", classificationSource: "rule", classificationConfidence: 1,
      },
    });
    const kuda = Buffer.from([
      "Kuda Microfinance Bank",
      "Account Number,2001119876",
      "Date,Description,Money Out,Money In,Balance",
      "03/09/2026,TRANSFER FROM ADA OKAFOR,1000,,9000",
    ].join("\n"));
    await importStatement(user.id, { name: "kuda.csv", bytes: kuda });
    expect(await db.reconFlag.count({ where: { userId: user.id, accountId: other.id } })).toBe(0);
  });
});

describe("statement password file", () => {
  it("refuses to treat a corrupt password file as empty", () => {
    const junk = "{not json";
    writeFileSync(passwordFile, junk);
    try {
      expect(() => saveStatementPassword("user-1", "GTBank", "synthetic-pdf-pass")).toThrow(/corrupt/);
      expect(readFileSync(passwordFile, "utf8")).toBe(junk);
    } finally {
      writeFileSync(passwordFile, JSON.stringify({ version: 1, entries: [] }));
    }
  });
});
