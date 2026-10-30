import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestSmsPayload } from "@/core/alerts/ingest";
import { ingestTransaction } from "@/core/ledger";

const SMS = `Acct:******1234
Amt:NGN3,450.00 DR
Desc:POS PURCHASE SHOP A
Bal:NGN80,000.00
Date:2026-10-07 3:17PM`;

describe("dedup across inboxes, SMS and push", () => {
  it("counts one debit when two inboxes, SMS and push describe it", async () => {
    const user = await db.user.create({ data: { email: "inbox-dedup@test.dev" } });
    const first = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "gmail",
      sourceTransactionId: "gmail-a-1",
      type: "DEBIT",
      amountMinor: 345_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-07T14:17:00.000Z"),
      description: "POS PURCHASE SHOP A",
      accountLast4: "1234",
      balanceAfterMinor: 8_000_000n,
      confidence: 1,
    });
    expect(first.status).toBe("created");
    if (first.status !== "created") return;

    const sameGmail = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "gmail",
      sourceTransactionId: "gmail-a-2",
      type: "DEBIT",
      amountMinor: 345_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-07T14:17:00.000Z"),
      description: "POS PURCHASE SHOP A",
      accountLast4: "1234",
      balanceAfterMinor: 8_000_000n,
      confidence: 1,
    });
    expect(sameGmail.status).toBe("duplicate");

    const secondInbox = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "imap",
      sourceTransactionId: "imap-b-1",
      type: "DEBIT",
      amountMinor: 345_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-07T14:18:00.000Z"),
      description: "POS PURCHASE SHOP A LEKKI",
      accountLast4: "1234",
      balanceAfterMinor: 7_655_000n,
      confidence: 1,
    });
    expect(secondInbox.status).toBe("duplicate");

    const sms = await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: SMS.replace("POS PURCHASE SHOP A", "ATM WITHDRAWAL IKEJA").replace("Bal:NGN80,000.00", "Bal:NGN70,000.00"),
      receivedAt: "2026-10-07T14:20:00.000Z",
      sourceId: "sms-inbox-1",
    });
    expect(sms.status).toBe("duplicate");

    const push = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "push",
      sourceTransactionId: "push-1",
      type: "DEBIT",
      amountMinor: 345_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-07T14:21:00.000Z"),
      description: "CARD ALERT DIFFERENT WORDS",
      accountLast4: "1234",
      balanceAfterMinor: 6_000_000n,
      confidence: 1,
    });
    expect(push.status).toBe("duplicate");
    if (push.status !== "duplicate") return;
    expect(push.transactionId).toBe(first.transactionId);

    const sources = await db.transactionSource.findMany({ where: { transactionId: first.transactionId } });
    expect(sources.map((row) => row.source).sort()).toEqual(["gmail", "gmail", "imap", "push", "sms"]);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(1);
  });

  it("keeps a different purchase and a different account", async () => {
    const user = await db.user.create({ data: { email: "inbox-split@test.dev" } });
    await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "gmail",
      sourceTransactionId: "gmail-shop",
      type: "DEBIT",
      amountMinor: 345_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-07T14:17:00.000Z"),
      description: "POS PURCHASE SHOP A",
      accountLast4: "1234",
      confidence: 1,
    });
    const otherPurchase = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "gmail",
      sourceTransactionId: "gmail-rent",
      type: "DEBIT",
      amountMinor: 345_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-07T14:40:00.000Z"),
      description: "RENT TRANSFER LANDLORD",
      accountLast4: "1234",
      confidence: 1,
    });
    expect(otherPurchase.status).toBe("created");

    const otherAccount = await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: SMS.replaceAll("1234", "5678"),
      receivedAt: "2026-10-07T14:20:00.000Z",
      sourceId: "sms-other-acct",
    });
    expect(otherAccount.status).toBe("created");
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(3);
  });
});
