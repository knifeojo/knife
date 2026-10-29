import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { heldReasonOf, isPossiblyAnotherAccount, POSSIBLY_ANOTHER_ACCOUNT } from "@/core/alerts/account-attach";
import { ingestSmsPayload, resolveUnparsed } from "@/core/alerts/ingest";
import { GTBANK_REGRESSION as R } from "@/core/fixtures/gtbank-alerts";
import { ingestTransaction, syncEmailSource } from "@/core/ledger";
import { GTBankParser } from "@/core/parsers/gtbank";
import { FixtureEmailSource } from "@/core/providers/fixture";
import { pendingReviewCount } from "@/core/review";

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

  it("holds an unmatched last-4 for review instead of attaching it to the only GTBank account", async () => {
    const user = await db.user.create({ data: { email: "gtb-one-acct@test.dev" } });
    const account = await db.account.create({
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
    expect(posted.status).toBe("review");
    if (posted.status !== "review") return;
    expect(posted.reason).toBe(POSSIBLY_ANOTHER_ACCOUNT);
    const accounts = await db.account.findMany({ where: { userId: user.id, institution: "GTBank" } });
    expect(accounts.map((a) => a.maskedAccountNumber)).toEqual(["****2468"]);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(0);
    const held = await db.unparsedAlert.findUniqueOrThrow({ where: { id: posted.id } });
    expect(isPossiblyAnotherAccount(held.reason)).toBe(true);
    expect(heldReasonOf(held.reason)).toBe("last-4");
    expect(held.status).toBe("open");
    expect(await pendingReviewCount(user.id)).toBeGreaterThanOrEqual(1);
    expect(account.id).toBe(accounts[0].id);
  });

  it("holds an unmatched last-4 for review when two GTBank accounts already exist", async () => {
    const user = await db.user.create({ data: { email: "gtb-two-acct@test.dev" } });
    await db.account.create({
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
    expect(posted.status).toBe("review");
    const accounts = await db.account.findMany({ where: { userId: user.id, institution: "GTBank" }, orderBy: { maskedAccountNumber: "asc" } });
    expect(accounts.map((row) => row.maskedAccountNumber)).toEqual(["****1111", "****2468"]);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(0);
  });

  it("attaches an email with no account shown onto the only GTBank account", async () => {
    const user = await db.user.create({ data: { email: "gtb-no-last4@test.dev" } });
    const account = await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTB 2468", maskedAccountNumber: "****2468", currency: "NGN" },
    });
    const posted = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "INBOX:93",
      type: "DEBIT",
      amountMinor: 1_000_00n,
      currency: "NGN",
      transactionDate: new Date("2026-10-03T10:00:00Z"),
      description: "POS SYNTHETIC MART LEKKI",
      confidence: 1,
    });
    expect(posted.status).toBe("created");
    if (posted.status !== "created") return;
    const row = await db.transaction.findUniqueOrThrow({ where: { id: posted.transactionId } });
    expect(row.accountId).toBe(account.id);
  });

  it("holds an email whose narration names a different account for review", async () => {
    const user = await db.user.create({ data: { email: "gtb-narration-last4@test.dev" } });
    await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTB 2468", maskedAccountNumber: "****2468", currency: "NGN" },
    });
    const posted = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "INBOX:94",
      type: "DEBIT",
      amountMinor: 1_000_00n,
      currency: "NGN",
      transactionDate: new Date("2026-10-03T10:00:00Z"),
      description: "Acct:******7643 POS SYNTHETIC MART",
      confidence: 1,
    });
    expect(posted.status).toBe("review");
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(0);
  });

  it("holds an email whose running balance does not fit the nearby chain", async () => {
    const user = await db.user.create({ data: { email: "gtb-bal-chain@test.dev" } });
    await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: SMS,
      receivedAt: "2026-10-02T11:20:00.000Z",
      sourceId: "sms-bal-2468",
    });
    const posted = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "INBOX:95",
      type: "DEBIT",
      amountMinor: 5_000_00n,
      currency: "NGN",
      transactionDate: new Date("2026-10-02T11:25:00Z"),
      description: "POS SYNTHETIC MART",
      balanceAfterMinor: 5_000_000n,
      confidence: 1,
    });
    expect(posted.status).toBe("review");
    const heldBal = await db.unparsedAlert.findFirst({ where: { userId: user.id, reason: { startsWith: POSSIBLY_ANOTHER_ACCOUNT } } });
    expect(heldBal).toBeTruthy();
    expect(heldReasonOf(heldBal!.reason)).toBe("balance");
  });

  it("holds a matching last-4 email whose running balance still does not fit the chain", async () => {
    const user = await db.user.create({ data: { email: "gtb-bal-match-last4@test.dev" } });
    await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: SMS,
      receivedAt: "2026-10-02T11:20:00.000Z",
      sourceId: "sms-bal-match",
    });
    const posted = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "INBOX:96",
      type: "DEBIT",
      amountMinor: 5_000_00n,
      currency: "NGN",
      transactionDate: new Date("2026-10-02T11:25:00Z"),
      description: "POS SYNTHETIC MART",
      accountLast4: "2468",
      balanceAfterMinor: 5_000_000n,
      confidence: 1,
    });
    expect(posted.status).toBe("review");
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(1);
  });

  it("merges a generic email into an SMS row within 10 minutes and keeps the SMS narration", async () => {
    const user = await db.user.create({ data: { email: "gtb-email-sms-time@test.dev" } });
    const sms = await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: SMS,
      receivedAt: "2026-10-02T11:20:00.000Z",
      sourceId: "sms-time-2468",
    });
    expect(sms.status).toBe("created");
    if (sms.status !== "created") return;

    const posted = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "INBOX:101",
      type: "DEBIT",
      amountMinor: 7_643_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-02T11:27:00Z"),
      description: "GTBank debit",
      accountLast4: "2468",
      confidence: 0.4,
    });
    expect(posted.status).toBe("duplicate");
    expect(posted.transactionId).toBe(sms.transactionId);
    const row = await db.transaction.findUniqueOrThrow({ where: { id: sms.transactionId } });
    expect(row.description).toMatch(/ADA OKAFOR/i);
    expect(row.description).not.toMatch(/^GTBank debit$/i);
    const sources = await db.transactionSource.findMany({ where: { transactionId: sms.transactionId } });
    expect(sources.map((s) => s.source).sort()).toEqual(["imap", "sms"]);
  });

  it("upgrades a generic email row when a later SMS brings the real narration", async () => {
    const user = await db.user.create({ data: { email: "gtb-email-first@test.dev" } });
    const email = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "INBOX:102",
      type: "DEBIT",
      amountMinor: 7_643_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-02T11:20:00Z"),
      description: "GTBank debit",
      accountLast4: "2468",
      confidence: 0.4,
    });
    expect(email.status).toBe("created");
    const sms = await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: SMS,
      receivedAt: "2026-10-02T11:22:00.000Z",
      sourceId: "sms-after-email",
    });
    expect(sms.status).toBe("duplicate");
    if (sms.status !== "duplicate") return;
    expect(sms.transactionId).toBe(email.transactionId);
    const row = await db.transaction.findUniqueOrThrow({ where: { id: email.transactionId } });
    expect(row.description).toMatch(/ADA OKAFOR/i);
    expect(row.description).not.toMatch(/^GTBank debit$/i);
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
    const summary = await syncEmailSource(user.id, conn.id, new FixtureEmailSource([R.gensHtmlWithWeakText]));
    const accounts = await db.account.findMany({ where: { userId: user.id, institution: "GTBank", currency: "NGN" } });
    expect(accounts.map((a) => a.maskedAccountNumber)).toEqual(["****4521"]);
    expect(summary.parseFailures).toBe(1);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.unparsedAlert.findFirst({ where: { userId: user.id, reason: { startsWith: POSSIBLY_ANOTHER_ACCOUNT } } })).toBeTruthy();
  });

  it("merges a matching last-4 email into the SMS row even when the running balance looks messy", async () => {
    const user = await db.user.create({ data: { email: "gtb-merge-before-hold@test.dev" } });
    const sms = await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: SMS,
      receivedAt: "2026-10-02T11:20:00.000Z",
      sourceId: "sms-merge-hold",
    });
    expect(sms.status).toBe("created");
    if (sms.status !== "created") return;
    const posted = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "INBOX:201",
      type: "DEBIT",
      amountMinor: 7_643_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-02T11:27:00Z"),
      description: "NIP TRANSFER TO ADA OKAFOR",
      accountLast4: "2468",
      balanceAfterMinor: 12n,
      confidence: 1,
    });
    expect(posted.status).toBe("duplicate");
    expect(posted.transactionId).toBe(sms.transactionId);
    expect(await db.unparsedAlert.count({ where: { userId: user.id } })).toBe(0);
  });

  it("does not hold when nearby SMS rows have no balance, or when a fee or VAT sits between neighbours", async () => {
    const user = await db.user.create({ data: { email: "gtb-no-hold-noise@test.dev" } });
    const account = await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTB 2468", maskedAccountNumber: "****2468", currency: "NGN" },
    });
    await db.transaction.create({
      data: {
        userId: user.id, accountId: account.id, source: "sms", sourceTransactionId: "sms-noball", fingerprint: "sms-noball",
        transactionDate: new Date("2026-10-02T10:00:00Z"), type: "DEBIT", amountMinor: 1_000_00n, currency: "NGN",
        description: "NIP TRANSFER TO ADA", category: "Transfers", classificationSource: "default", classificationConfidence: 0.5,
      },
    });
    const missing = await ingestTransaction(user.id, {
      institution: "GTBank", source: "imap", sourceTransactionId: "INBOX:202",
      type: "DEBIT", amountMinor: 2_000_00n, currency: "NGN",
      transactionDate: new Date("2026-10-02T10:10:00Z"), description: "POS SYNTHETIC MART",
      accountLast4: "2468", balanceAfterMinor: 50_000_00n, confidence: 1,
    });
    expect(missing.status).toBe("created");

    const user2 = await db.user.create({ data: { email: "gtb-no-hold-fee@test.dev" } });
    const account2 = await db.account.create({
      data: { userId: user2.id, institution: "GTBank", accountName: "GTB 2468", maskedAccountNumber: "****2468", currency: "NGN" },
    });
    await db.transaction.create({
      data: {
        userId: user2.id, accountId: account2.id, source: "sms", sourceTransactionId: "sms-fee-prev", fingerprint: "sms-fee-prev",
        transactionDate: new Date("2026-10-02T10:00:00Z"), type: "DEBIT", amountMinor: 1_000_00n, currency: "NGN",
        balanceAfterMinor: 100_000_00n, description: "NIP TRANSFER TO ADA", category: "Transfers", classificationSource: "default", classificationConfidence: 0.5,
      },
    });
    await db.transaction.create({
      data: {
        userId: user2.id, accountId: account2.id, source: "sms", sourceTransactionId: "sms-vat", fingerprint: "sms-vat",
        transactionDate: new Date("2026-10-02T10:01:00Z"), type: "DEBIT", amountMinor: 750n, currency: "NGN",
        balanceAfterMinor: 99_992_50n, description: "VAT ON NIP TRANSFER", category: "Fees", classificationSource: "rule", classificationConfidence: 1,
      },
    });
    const throughFee = await ingestTransaction(user2.id, {
      institution: "GTBank", source: "imap", sourceTransactionId: "INBOX:203",
      type: "DEBIT", amountMinor: 5_000_00n, currency: "NGN",
      transactionDate: new Date("2026-10-02T10:15:00Z"), description: "POS SYNTHETIC MART",
      accountLast4: "2468", balanceAfterMinor: 40_000_00n, confidence: 1,
    });
    expect(throughFee.status).toBe("created");
  });

  it("does not hold when the only neighbour is in the same minute", async () => {
    const user = await db.user.create({ data: { email: "gtb-same-minute@test.dev" } });
    await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: SMS,
      receivedAt: "2026-10-02T11:20:00.000Z",
      sourceId: "sms-same-min",
    });
    const posted = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "INBOX:204",
      type: "DEBIT",
      amountMinor: 2_000_00n,
      currency: "NGN",
      transactionDate: new Date("2026-10-02T11:20:30Z"),
      description: "POS SYNTHETIC MART",
      accountLast4: "2468",
      balanceAfterMinor: 12n,
      confidence: 1,
    });
    expect(posted.status).toBe("created");
  });

  it("lets Review attach, create, or ignore a held alert, and counts it as pending", async () => {
    const user = await db.user.create({ data: { email: "gtb-review-hold@test.dev" } });
    const account = await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTB 2468", maskedAccountNumber: "****2468", currency: "NGN" },
    });
    const held = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "INBOX:205",
      type: "DEBIT",
      amountMinor: 3_000_00n,
      currency: "NGN",
      transactionDate: new Date("2026-10-03T10:00:00Z"),
      description: "POS SYNTHETIC MART",
      accountLast4: "7643",
      confidence: 1,
    });
    expect(held.status).toBe("review");
    if (held.status !== "review") return;
    expect(await pendingReviewCount(user.id)).toBeGreaterThanOrEqual(1);

    const ignored = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "INBOX:206",
      type: "DEBIT",
      amountMinor: 4_000_00n,
      currency: "NGN",
      transactionDate: new Date("2026-10-03T11:00:00Z"),
      description: "POS SYNTHETIC MART TWO",
      accountLast4: "9999",
      confidence: 1,
    });
    expect(ignored.status).toBe("review");
    if (ignored.status !== "review") return;
    expect(await resolveUnparsed(user.id, ignored.id, "ignore")).toEqual({ ok: true });

    const created = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "INBOX:207",
      type: "DEBIT",
      amountMinor: 6_000_00n,
      currency: "NGN",
      transactionDate: new Date("2026-10-03T12:00:00Z"),
      description: "POS SYNTHETIC MART THREE",
      accountLast4: "1111",
      confidence: 1,
    });
    expect(created.status).toBe("review");
    if (created.status !== "review") return;
    expect(await resolveUnparsed(user.id, created.id, "create")).toEqual({ ok: true });
    expect(await db.account.findFirst({ where: { userId: user.id, maskedAccountNumber: "****1111" } })).toBeTruthy();

    expect(await resolveUnparsed(user.id, held.id, "attach", { accountId: account.id })).toEqual({ ok: true });
    const attached = await db.transaction.findFirst({ where: { userId: user.id, sourceTransactionId: "INBOX:205" } });
    expect(attached?.accountId).toBe(account.id);
    expect(await db.unparsedAlert.count({ where: { userId: user.id, status: "open" } })).toBe(0);
  });

  it("does not recategorise an older matched row from a later email narration", async () => {
    const user = await db.user.create({ data: { email: "gtb-no-recat@test.dev" } });
    const existing = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "sms",
      sourceTransactionId: "sms-june-70k",
      type: "DEBIT",
      amountMinor: 70_000_00n,
      currency: "NGN",
      transactionDate: new Date("2026-06-15T10:00:00Z"),
      description: "NIP TRANSFER TO KOFI MENSAH",
      accountLast4: "2468",
      confidence: 1,
    });
    expect(existing.status).toBe("created");
    if (existing.status !== "created") return;
    await db.transaction.update({
      where: { id: existing.transactionId },
      data: { category: "Transfers", subcategory: null, classificationSource: "default", classificationConfidence: 0.4 },
    });
    const email = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "INBOX:208",
      type: "DEBIT",
      amountMinor: 70_000_00n,
      currency: "NGN",
      transactionDate: new Date("2026-06-15T10:04:00Z"),
      description: "NIP TRANSFER TO MUMMY KOFI MENSAH UPKEEP",
      accountLast4: "2468",
      confidence: 1,
    });
    expect(email.status).toBe("duplicate");
    const row = await db.transaction.findUniqueOrThrow({ where: { id: existing.transactionId } });
    expect(row.category).toBe("Transfers");
    expect(row.classificationSource).toBe("default");
  });

  it("does not pair unrelated older rows during an email sync", async () => {
    const user = await db.user.create({ data: { email: "gtb-no-repair@test.dev" } });
    const gtb = await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTB 2468", maskedAccountNumber: "****2468", currency: "NGN", holderName: "Ada" },
    });
    const opay = await db.account.create({
      data: { userId: user.id, institution: "OPay", accountName: "OPay 1111", maskedAccountNumber: "****1111", currency: "NGN", holderName: "Ada" },
    });
    const debit = await db.transaction.create({
      data: {
        userId: user.id, accountId: gtb.id, source: "statement", sourceTransactionId: "oct-9k", fingerprint: "oct-9k",
        transactionDate: new Date("2026-10-20T10:00:00Z"), type: "DEBIT", amountMinor: 9_000_00n, currency: "NGN",
        description: "NIP TRANSFER TO OPAY - ADA", category: "Transfers", classificationSource: "default", classificationConfidence: 0.4,
      },
    });
    const credit = await db.transaction.create({
      data: {
        userId: user.id, accountId: opay.id, source: "statement", sourceTransactionId: "oct-9k-in", fingerprint: "oct-9k-in",
        transactionDate: new Date("2026-10-20T10:05:00Z"), type: "CREDIT", amountMinor: 9_000_00n, currency: "NGN",
        description: "Transfer from Guaranty Trust Bank", category: "Transfers", classificationSource: "default", classificationConfidence: 0.4,
      },
    });
    const conn = await db.financialConnection.create({
      data: { userId: user.id, provider: "fixture", lastSyncedAt: new Date("2026-01-01") },
    });
    await syncEmailSource(user.id, conn.id, new FixtureEmailSource([R.gensHtmlWithWeakText]));
    const stillDebit = await db.transaction.findUniqueOrThrow({ where: { id: debit.id } });
    const stillCredit = await db.transaction.findUniqueOrThrow({ where: { id: credit.id } });
    expect(stillDebit.transferPairId).toBeNull();
    expect(stillCredit.transferPairId).toBeNull();
    expect(stillDebit.category).toBe("Transfers");
  });

  it("does not open extra balance-gap rows after an email sync", async () => {
    const user = await db.user.create({ data: { email: "gtb-no-gap-inflate@test.dev" } });
    const account = await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTB 2468", maskedAccountNumber: "****2468", currency: "NGN" },
    });
    await db.transaction.create({
      data: {
        userId: user.id, accountId: account.id, source: "sms", sourceTransactionId: "gap-a", fingerprint: "gap-a2",
        transactionDate: new Date("2026-10-01T10:00:00Z"), type: "DEBIT", amountMinor: 1_000_00n, currency: "NGN",
        balanceAfterMinor: 50_000_00n, description: "A", category: "Other", classificationSource: "rule", classificationConfidence: 1,
      },
    });
    await db.transaction.create({
      data: {
        userId: user.id, accountId: account.id, source: "sms", sourceTransactionId: "gap-b", fingerprint: "gap-b2",
        transactionDate: new Date("2026-10-02T10:00:00Z"), type: "DEBIT", amountMinor: 1_000_00n, currency: "NGN",
        balanceAfterMinor: 40_000_00n, description: "B", category: "Other", classificationSource: "rule", classificationConfidence: 1,
      },
    });
    const { scanBalanceGaps } = await import("@/core/alerts/balance");
    expect(await scanBalanceGaps(user.id, account.id)).toBe(1);
    const before = await db.balanceGap.count({ where: { userId: user.id } });
    const conn = await db.financialConnection.create({
      data: { userId: user.id, provider: "fixture", lastSyncedAt: new Date("2026-01-01") },
    });
    await syncEmailSource(user.id, conn.id, new FixtureEmailSource([R.gensHtmlWithWeakText]));
    expect(await db.balanceGap.count({ where: { userId: user.id } })).toBe(before);
  });
});
