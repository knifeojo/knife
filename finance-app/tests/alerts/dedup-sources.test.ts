import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestTransaction } from "@/core/ledger";
import { ingestSmsPayload } from "@/core/alerts/ingest";
import { scanBalanceGaps } from "@/core/alerts/balance";
import { linkAdjacentFee } from "@/core/alerts/fees";
import { reconcileAfterStatement } from "@/core/alerts/after-statement";
import { reconcileAlertsVsStatement } from "@/core/alerts/reconcile";

const TRANSFER = `Acct:******1234
Amt:NGN3,450.00 DR
Desc:OUTWARD TRANSFER TO MONIEMFB - JOHN DOE
Bal:NGN412,890.50
Date:2026-10-07 3:17PM`;

const FEE = `Acct:******1234
Amt:NGN25.00 DR
Desc:Commission on NIP Transfer
Bal:NGN412,865.50
Date:2026-10-07 3:17PM`;

describe("SMS / email / statement merge, fees and balances", () => {
  let userId: string;

  beforeAll(async () => {
    const user = await db.user.create({ data: { email: "alerts-dedup@test.dev" } });
    userId = user.id;
  });

  it("merges the same transfer from SMS, email and statement into one row", async () => {
    const sms = await ingestSmsPayload(userId, { sender: "GTBank", body: TRANSFER, receivedAt: "2026-10-07T14:17:00.000Z", sourceId: "sms-1" });
    expect(sms.status).toBe("created");
    if (sms.status !== "created") return;

    const email = await ingestTransaction(userId, {
      institution: "GTBank",
      source: "gmail",
      sourceTransactionId: "gmail-1",
      type: "DEBIT",
      amountMinor: 345_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-07T14:17:00Z"),
      description: "OUTWARD TRANSFER TO MONIEMFB - JOHN DOE",
      accountLast4: "1234",
      balanceAfterMinor: 41_289_050n,
      confidence: 1,
    });
    expect(email.status).toBe("duplicate");
    expect(email.transactionId).toBe(sms.transactionId);

    const stmt = await ingestTransaction(userId, {
      institution: "GTBank",
      source: "statement",
      sourceTransactionId: "stmt-row-1",
      type: "DEBIT",
      amountMinor: 345_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-07T00:00:00Z"),
      description: "NIP TRANSFER TO MONIEMFB JOHN DOE",
      accountLast4: "1234",
      balanceAfterMinor: 41_289_050n,
      confidence: 1,
    });
    expect(stmt.status).toBe("duplicate");
    expect(stmt.transactionId).toBe(sms.transactionId);

    const sources = await db.transactionSource.findMany({ where: { transactionId: sms.transactionId } });
    expect(sources.map((s) => s.source).sort()).toEqual(["gmail", "sms", "statement"]);
    const row = await db.transaction.findUniqueOrThrow({ where: { id: sms.transactionId } });
    expect(row.source).toBe("sms");
  });

  it("links Commission on NIP Transfer as a fee of the adjacent transfer", async () => {
    const fee = await ingestSmsPayload(userId, { sender: "GTBank", body: FEE, receivedAt: "2026-10-07T14:17:00.000Z", sourceId: "sms-fee" });
    expect(fee.status).toBe("created");
    if (fee.status !== "created") return;
    const linked = await db.transaction.findUniqueOrThrow({ where: { id: fee.transactionId } });
    expect(linked.category).toBe("Fees");
    expect(linked.feeOfId).toBeTruthy();
    const parent = await db.transaction.findUniqueOrThrow({ where: { id: linked.feeOfId! } });
    expect(parent.amountMinor).toBe(345_000n);
    expect(parent.amountMinor + linked.amountMinor).toBe(347_500n);
    await linkAdjacentFee(userId, linked.id);
  });

  it("flags a running-balance gap as a possible missed transaction", async () => {
    const user = await db.user.create({ data: { email: "gaps@test.dev" } });
    const account = await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTBank ••1234", maskedAccountNumber: "****1234", currency: "NGN" },
    });
    await db.transaction.create({
      data: {
        userId: user.id, accountId: account.id, source: "sms", sourceTransactionId: "a", fingerprint: "gap-a",
        transactionDate: new Date("2026-10-03T10:00:00Z"), type: "DEBIT", amountMinor: 100_000n, currency: "NGN",
        balanceAfterMinor: 1_000_000n, description: "A", category: "Other", classificationSource: "rule", classificationConfidence: 1,
      },
    });
    const b = await db.transaction.create({
      data: {
        userId: user.id, accountId: account.id, source: "sms", sourceTransactionId: "b", fingerprint: "gap-b",
        transactionDate: new Date("2026-10-03T11:00:00Z"), type: "DEBIT", amountMinor: 50_000n, currency: "NGN",
        balanceAfterMinor: 800_000n, description: "B", category: "Other", classificationSource: "rule", classificationConfidence: 1,
      },
    });
    const n = await scanBalanceGaps(user.id, account.id);
    expect(n).toBe(1);
    const gap = await db.balanceGap.findFirstOrThrow({ where: { userId: user.id } });
    expect(gap.currentTxId).toBe(b.id);
    expect(gap.gapMinor).toBe(150_000n);
  });

  it("flags an alert without a statement row once a statement covers that date", async () => {
    const user = await db.user.create({ data: { email: "recon@test.dev" } });
    const account = await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTBank ••9999", maskedAccountNumber: "****9999", currency: "NGN" },
    });
    const alert = await db.transaction.create({
      data: {
        userId: user.id, accountId: account.id, source: "sms", sourceTransactionId: "r1", fingerprint: "recon-1",
        transactionDate: new Date("2026-10-01T10:00:00Z"), type: "DEBIT", amountMinor: 1_000n, currency: "NGN",
        description: "Alert only", category: "Other", classificationSource: "rule", classificationConfidence: 1,
        sources: { create: { userId: user.id, source: "sms", sourceTransactionId: "r1", matchType: "created" } },
      },
    });
    await db.transaction.create({
      data: {
        userId: user.id, accountId: account.id, source: "statement", sourceTransactionId: "r2", fingerprint: "recon-2",
        transactionDate: new Date("2026-10-02T10:00:00Z"), type: "DEBIT", amountMinor: 2_000n, currency: "NGN",
        description: "Statement only", category: "Other", classificationSource: "rule", classificationConfidence: 1,
        sources: { create: { userId: user.id, source: "statement", sourceTransactionId: "r2", matchType: "created" } },
      },
    });
    const r = await reconcileAlertsVsStatement(user.id, account.id, new Date("2026-10-01"), new Date("2026-10-03"));
    expect(r.alertOnly).toBe(1);
    expect(r.statementOnly).toBe(1);
    const flags = await db.reconFlag.findMany({ where: { userId: user.id } });
    expect(flags.some((f) => f.transactionId === alert.id && f.kind === "alert_without_statement")).toBe(true);
  });

  it("links a GTBank SMS debit to the statement row for that amount on the same day", async () => {
    const user = await db.user.create({ data: { email: "sms-stmt-day@test.dev" } });
    const stmt = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "statement",
      sourceTransactionId: "stmt-10k",
      type: "DEBIT",
      amountMinor: 1_000_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-04T00:00:00.000Z"),
      description: "WEB PURCHASE 991122",
      accountLast4: "1234",
      balanceAfterMinor: 4_000_000n,
      confidence: 1,
    });
    expect(stmt.status).toBe("created");
    await reconcileAfterStatement(user.id);

    const sms = await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: `Acct:******1234
Amt:NGN10,000.00 DR
Desc:POS ACME MART LEKKI
Bal:NGN50,000.00
Date:2026-10-04 8:45PM`,
      receivedAt: "2026-10-04T19:45:00.000Z",
      sourceId: "sms-10k-evening",
    });
    expect(sms.status).toBe("duplicate");
    if (sms.status !== "duplicate") return;
    expect(sms.transactionId).toBe(stmt.transactionId);

    const weekLater = await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: `Acct:******1234
Amt:NGN10,000.00 DR
Desc:POS ACME MART LEKKI
Bal:NGN40,000.00
Date:2026-10-11 8:00PM`,
      receivedAt: "2026-10-11T19:00:00.000Z",
      sourceId: "sms-10k-week",
    });
    expect(weekLater.status).toBe("created");
    if (weekLater.status !== "created") return;
    expect(weekLater.transactionId).not.toBe(stmt.transactionId);
  });

  it("links an SMS whose receivedAt is the next Lagos morning to the previous value date", async () => {
    const user = await db.user.create({ data: { email: "sms-stmt-tz@test.dev" } });
    const stmt = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "statement",
      sourceTransactionId: "stmt-10k-tz",
      type: "DEBIT",
      amountMinor: 1_000_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-04T00:00:00.000Z"),
      description: "WEB PURCHASE 884411",
      accountLast4: "5678",
      confidence: 1,
    });
    await reconcileAfterStatement(user.id);
    const sms = await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: `Acct:******5678
Amt:NGN10,000.00 DR
Desc:POS ACME MART
Bal:NGN20,000.00`,
      receivedAt: "2026-10-04T23:30:00.000Z",
      sourceId: "sms-10k-tz",
    });
    expect(sms.status).toBe("duplicate");
    if (sms.status !== "duplicate") return;
    expect(sms.transactionId).toBe(stmt.transactionId);
  });

  it("is idempotent on a repeated SMS", async () => {
    const again = await ingestSmsPayload(userId, { sender: "GTBank", body: TRANSFER, receivedAt: "2026-10-07T14:17:00.000Z", sourceId: "sms-1" });
    expect(again.status).toBe("duplicate");
  });

  it("links a PAYMENTDEEL SMS credit to an existing Deel statement credit", async () => {
    const user = await db.user.create({ data: { email: "deel-sms@test.dev" } });
    const sms = await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: `Acct:******1234
Amt:NGN518,390.25 CR
Desc:- - PAYMENTDEEL INC-WRAMFB-GRP .
Bal:NGN540,120.80
Date:2026-10-07 11:08AM`,
      receivedAt: "2026-10-07T10:08:00.000Z",
      sourceId: "gt-deel-sms",
    });
    expect(sms.status).toBe("created");
    if (sms.status !== "created") return;
    const posted = await db.transaction.findUniqueOrThrow({ where: { id: sms.transactionId } });
    expect(posted.category).toBe("Income");
    expect(posted.subcategory).toBe("Salary");

    const stmt = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "statement",
      sourceTransactionId: "stmt-deel-1",
      type: "CREDIT",
      amountMinor: 51_839_025n,
      currency: "NGN",
      transactionDate: new Date("2026-10-07T00:00:00Z"),
      description: "W5WM-MONIE MFB-DEEL INC",
      accountLast4: "1234",
      confidence: 1,
    });
    expect(stmt.status).toBe("duplicate");
    expect(stmt.transactionId).toBe(sms.transactionId);
  });

  it("treats a Sterling inflow from the owner's profile name as an own transfer", async () => {
    const user = await db.user.create({ data: { email: "sterling-own@test.dev", name: "John Samuel Doe" } });
    const inn = await ingestSmsPayload(user.id, {
      sender: "STERLING",
      body: "Money In! NGN180,000.00 has arrived from DOE JOHN SAMUEL into ******4321 at 2026-10-11 17:36:41. You have NGN195,640.88",
      receivedAt: "2026-10-11T16:36:41.000Z",
      sourceId: "st-own",
    });
    expect(inn.status).toBe("created");
    if (inn.status !== "created") return;
    const row = await db.transaction.findUniqueOrThrow({ where: { id: inn.transactionId } });
    expect(row.category).toBe("Own transfer");
    expect(row.subcategory).toBe("Between own accounts");
  });
});
