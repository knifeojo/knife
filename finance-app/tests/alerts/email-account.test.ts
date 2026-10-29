import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestSmsPayload } from "@/core/alerts/ingest";
import { GTBANK_REGRESSION as R } from "@/core/fixtures/gtbank-alerts";
import { ingestTransaction, syncEmailSource } from "@/core/ledger";
import { GTBankParser } from "@/core/parsers/gtbank";
import { FixtureEmailSource } from "@/core/providers/fixture";

const parser = new GTBankParser();

const SMS = `Acct:******2468
Amt:NGN76,430.00 DR
Desc:NIP TRANSFER TO ADA OKAFOR
Bal:NGN900,000.00
Date:2026-10-02 12:20PM`;

describe("GTBank email alerts attach to the SMS account and dedupe", () => {
  it("does not create a second GTBank account from amount digits, and merges the email into the SMS row", async () => {
    const user = await db.user.create({ data: { email: "gtb-email-acct@test.dev" } });
    const sms = await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: SMS,
      receivedAt: "2026-10-02T11:20:00.000Z",
      sourceId: "sms-2468",
    });
    expect(sms.status).toBe("created");
    if (sms.status !== "created") return;

    const parsed = parser.parse(R.gensHtmlWithWeakText)!;
    expect(parsed.accountLast4).toBe("2468");
    expect(parsed.description).toContain("ADA OKAFOR");

    const email = await ingestTransaction(user.id, {
      ...parsed,
      source: "imap",
      sourceTransactionId: "INBOX:88",
    });
    expect(email.status).toBe("duplicate");
    expect(email.transactionId).toBe(sms.transactionId);

    const accounts = await db.account.findMany({ where: { userId: user.id, institution: "GTBank" } });
    expect(accounts.map((a) => a.maskedAccountNumber)).toEqual(["****2468"]);

    const sources = await db.transactionSource.findMany({ where: { transactionId: sms.transactionId } });
    expect(sources.map((s) => s.source).sort()).toEqual(["imap", "sms"]);
    const row = await db.transaction.findUniqueOrThrow({ where: { id: sms.transactionId } });
    expect(row.counterparty).toMatch(/ADA OKAFOR/i);
    expect(row.description).not.toMatch(/^GTBank debit$/i);
  });

  it("attaches an unmatched last-4 to the only GTBank account instead of opening a duplicate", async () => {
    const user = await db.user.create({ data: { email: "gtb-one-acct@test.dev" } });
    await db.account.create({
      data: {
        userId: user.id,
        institution: "GTBank",
        accountName: "GTBank NGN ••2468",
        maskedAccountNumber: "****2468",
        currency: "NGN",
      },
    });
    const posted = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "INBOX:91",
      type: "DEBIT",
      amountMinor: 5_000_00n,
      currency: "NGN",
      transactionDate: new Date("2026-10-03T10:00:00Z"),
      description: "NIP TRANSFER TO KEMI ADE",
      accountLast4: "7643",
      confidence: 1,
    });
    expect(posted.status).toBe("created");
    const accounts = await db.account.findMany({ where: { userId: user.id, institution: "GTBank" } });
    expect(accounts.map((a) => a.maskedAccountNumber)).toEqual(["****2468"]);
    const row = await db.transaction.findUniqueOrThrow({ where: { id: posted.transactionId } });
    expect(row.accountId).toBe(accounts[0].id);
  });

  it("does not invent a third last-4 account when two GTBank accounts already exist", async () => {
    const user = await db.user.create({ data: { email: "gtb-two-acct@test.dev" } });
    const a = await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTB 2468", maskedAccountNumber: "****2468", currency: "NGN" },
    });
    await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTB 1111", maskedAccountNumber: "****1111", currency: "NGN" },
    });
    const posted = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "INBOX:92",
      type: "DEBIT",
      amountMinor: 2_000_00n,
      currency: "NGN",
      transactionDate: new Date("2026-10-03T10:00:00Z"),
      description: "POS SYNTHETIC MART",
      accountLast4: "7643",
      confidence: 1,
    });
    const accounts = await db.account.findMany({ where: { userId: user.id, institution: "GTBank" }, orderBy: { maskedAccountNumber: "asc" } });
    expect(accounts.map((row) => row.maskedAccountNumber)).toEqual(["****1111", "****2468", "PRIMARY"]);
    const row = await db.transaction.findUniqueOrThrow({ where: { id: posted.transactionId } });
    expect(row.accountId).not.toBe(a.id);
    expect(accounts.find((acct) => acct.id === row.accountId)?.maskedAccountNumber).toBe("PRIMARY");
  });

  it("links an IMAP alert to the statement row for the same amount on a covered day", async () => {
    const user = await db.user.create({ data: { email: "gtb-stmt-dedup@test.dev" } });
    const account = await db.account.create({
      data: {
        userId: user.id,
        institution: "GTBank",
        accountName: "GTBank ••2468",
        maskedAccountNumber: "****2468",
        currency: "NGN",
        statementCoveredFrom: new Date("2026-10-01T00:00:00Z"),
        statementCoveredTo: new Date("2026-10-31T00:00:00Z"),
      },
    });
    const stmt = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "statement",
      sourceTransactionId: "stmt-oct-2",
      type: "DEBIT",
      amountMinor: 7_643_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-02T00:00:00Z"),
      description: "NIP TRANSFER TO ADA OKAFOR",
      accountLast4: "2468",
      confidence: 1,
    });
    const parsed = parser.parse(R.gensHtmlWithWeakText)!;
    const email = await ingestTransaction(user.id, {
      ...parsed,
      source: "imap",
      sourceTransactionId: "Archive:12",
    });
    expect(email.status).toBe("duplicate");
    expect(email.transactionId).toBe(stmt.transactionId);
    const row = await db.transaction.findUniqueOrThrow({ where: { id: stmt.transactionId } });
    expect(row.accountId).toBe(account.id);
    const sources = await db.transactionSource.findMany({ where: { transactionId: stmt.transactionId } });
    expect(sources.map((s) => s.source).sort()).toEqual(["imap", "statement"]);
  });

  it("keeps a fixture sync from creating a second account when one GTBank account already exists", async () => {
    const user = await db.user.create({ data: { email: "gtb-sync-one@test.dev" } });
    await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTB", maskedAccountNumber: "****4521", currency: "NGN" },
    });
    const conn = await db.financialConnection.create({
      data: { userId: user.id, provider: "fixture", lastSyncedAt: new Date("2026-01-01") },
    });
    await syncEmailSource(user.id, conn.id, new FixtureEmailSource([R.gensHtmlWithWeakText]));
    const accounts = await db.account.findMany({ where: { userId: user.id, institution: "GTBank", currency: "NGN" } });
    expect(accounts.map((a) => a.maskedAccountNumber)).toEqual(["****4521"]);
  });
});
