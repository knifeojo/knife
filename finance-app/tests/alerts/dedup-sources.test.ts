import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestTransaction } from "@/core/ledger";
import { ingestSmsPayload } from "@/core/alerts/ingest";
import { scanBalanceGaps } from "@/core/alerts/balance";
import { linkAdjacentFee } from "@/core/alerts/fees";
import { reconcileAlertsVsStatement } from "@/core/alerts/reconcile";

const TRANSFER = `Acct:******1234
Amt:NGN2,800.00 DR
Desc:OUTWARD TRANSFER TO MONIEMFB - JOHN DOE
Bal:NGN354,145.94
Date:2026-10-03 4:29PM`;

const FEE = `Acct:******1234
Amt:NGN10.00 DR
Desc:Commission on NIP Transfer
Bal:NGN354,135.94
Date:2026-10-03 4:29PM`;

describe("SMS / email / statement merge, fees and balances", () => {
  let userId: string;

  beforeAll(async () => {
    const user = await db.user.create({ data: { email: "alerts-dedup@test.dev" } });
    userId = user.id;
  });

  it("merges the same transfer from SMS, email and statement into one row", async () => {
    const sms = await ingestSmsPayload(userId, { sender: "GTBank", body: TRANSFER, receivedAt: "2026-10-03T15:29:00.000Z", sourceId: "sms-1" });
    expect(sms.status).toBe("created");
    if (sms.status !== "created") return;

    const email = await ingestTransaction(userId, {
      institution: "GTBank",
      source: "gmail",
      sourceTransactionId: "gmail-1",
      type: "DEBIT",
      amountMinor: 280_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-03T15:29:00Z"),
      description: "OUTWARD TRANSFER TO MONIEMFB - JOHN DOE",
      accountLast4: "1234",
      balanceAfterMinor: 35_414_594n,
      confidence: 1,
    });
    expect(email.status).toBe("duplicate");
    expect(email.transactionId).toBe(sms.transactionId);

    const stmt = await ingestTransaction(userId, {
      institution: "GTBank",
      source: "statement",
      sourceTransactionId: "stmt-row-1",
      type: "DEBIT",
      amountMinor: 280_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-03T00:00:00Z"),
      description: "NIP TRANSFER TO MONIEMFB JOHN DOE",
      accountLast4: "1234",
      balanceAfterMinor: 35_414_594n,
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
    const fee = await ingestSmsPayload(userId, { sender: "GTBank", body: FEE, receivedAt: "2026-10-03T15:29:00.000Z", sourceId: "sms-fee" });
    expect(fee.status).toBe("created");
    if (fee.status !== "created") return;
    const linked = await db.transaction.findUniqueOrThrow({ where: { id: fee.transactionId } });
    expect(linked.category).toBe("Fees");
    expect(linked.feeOfId).toBeTruthy();
    const parent = await db.transaction.findUniqueOrThrow({ where: { id: linked.feeOfId! } });
    expect(parent.amountMinor).toBe(280_000n);
    expect(parent.amountMinor + linked.amountMinor).toBe(281_000n);
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

  it("is idempotent on a repeated SMS", async () => {
    const again = await ingestSmsPayload(userId, { sender: "GTBank", body: TRANSFER, receivedAt: "2026-10-03T15:29:00.000Z", sourceId: "sms-1" });
    expect(again.status).toBe("duplicate");
  });

  it("links a PAYMENTDEEL SMS credit to an existing Deel statement credit", async () => {
    const user = await db.user.create({ data: { email: "deel-sms@test.dev" } });
    const sms = await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: `Acct:******1234
Amt:NGN645,242.76 CR
Desc:- - PAYMENTDEEL INC-WRAMFB-GRP .
Bal:NGN672,045.70
Date:2026-10-03 1:23PM`,
      receivedAt: "2026-10-03T12:23:00.000Z",
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
      amountMinor: 64_524_276n,
      currency: "NGN",
      transactionDate: new Date("2026-10-03T00:00:00Z"),
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
      body: "Money In! NGN250,000.00 has arrived from DOE JOHN SAMUEL into ******8537 at 2026-09-30 18:24:12. You have NGN256,176.61",
      receivedAt: "2026-09-30T17:24:12.000Z",
      sourceId: "st-own",
    });
    expect(inn.status).toBe("created");
    if (inn.status !== "created") return;
    const row = await db.transaction.findUniqueOrThrow({ where: { id: inn.transactionId } });
    expect(row.category).toBe("Own transfer");
    expect(row.subcategory).toBe("Between own accounts");
  });
});
