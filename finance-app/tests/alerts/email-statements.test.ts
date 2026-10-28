import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
import { passwordsForInstitution, saveStatementPassword } from "@/core/statements/passwords";

const previousPasswordFile = process.env.STATEMENT_PASSWORD_FILE;
const passwordFile = join(mkdtempSync(join(tmpdir(), "stmt-pw-")), "passwords.json");
process.env.STATEMENT_PASSWORD_FILE = passwordFile;

afterAll(() => {
  if (previousPasswordFile === undefined) delete process.env.STATEMENT_PASSWORD_FILE;
  else process.env.STATEMENT_PASSWORD_FILE = previousPasswordFile;
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
    expect(row.encryptedBytes).toBeNull();
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
    expect(row.encryptedBytes).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(PDF_PASSWORD);
    expect(existsSync(passwordFile) && readFileSync(passwordFile, "utf8").includes(PDF_PASSWORD)).toBe(false);

    const wrong = await unlockStatement(user.id, row.id, "not-the-password");
    expect(wrong).toEqual({ error: "That password did not open the statement." });
    expect((await db.statementFile.findFirstOrThrow({ where: { id: row.id } })).status).toBe("needs_password");
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(0);

    const opened = await unlockStatement(user.id, row.id, PDF_PASSWORD, { remember: true });
    expect(opened).toMatchObject({ ok: true, summary: { created: 4, institution: "GTBank" } });
    expect((await db.statementFile.findFirstOrThrow({ where: { id: row.id } })).status).toBe("imported");
    expect((await db.statementFile.findFirstOrThrow({ where: { id: row.id } })).encryptedBytes).toBeNull();
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
    expect(row.encryptedBytes).toBeNull();
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
