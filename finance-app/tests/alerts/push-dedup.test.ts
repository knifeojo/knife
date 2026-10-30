import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestPushPayload, ingestSmsPayload } from "@/core/alerts/ingest";
import { ingestTransaction } from "@/core/ledger";

const SMS = `Acct:******1234
Amt:NGN3,450.00 DR
Desc:POS PURCHASE SHOP A
Bal:NGN80,000.00
Date:2026-10-07 3:17PM`;

const PUSH = `Acct:******1234
Amt:NGN3,450.00 DR
Desc:ATM WITHDRAWAL IKEJA
Bal:NGN76,550.00
Date:2026-10-07 3:20PM`;

describe("push alert dedup", () => {
  it("counts one debit when the same amount arrives by SMS and push", async () => {
    const user = await db.user.create({ data: { email: "push-sms@test.dev" } });
    const sms = await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: SMS,
      receivedAt: "2026-10-07T14:17:00.000Z",
      sourceId: "sms-push-1",
    });
    expect(sms.status).toBe("created");
    if (sms.status !== "created") return;

    const push = await ingestPushPayload(user.id, {
      sender: "GTBank",
      body: PUSH,
      receivedAt: "2026-10-07T14:20:00.000Z",
      sourceId: "push-1",
    });
    expect(push.status).toBe("duplicate");
    if (push.status !== "duplicate") return;
    expect(push.transactionId).toBe(sms.transactionId);

    const sources = await db.transactionSource.findMany({ where: { transactionId: sms.transactionId } });
    expect(sources.map((row) => row.source).sort()).toEqual(["push", "sms"]);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(1);
  });

  it("keeps a push on a different account or outside the window", async () => {
    const user = await db.user.create({ data: { email: "push-split@test.dev" } });
    const sms = await ingestSmsPayload(user.id, {
      sender: "GTBank",
      body: SMS,
      receivedAt: "2026-10-07T14:17:00.000Z",
      sourceId: "sms-push-2",
    });
    expect(sms.status).toBe("created");

    const otherAccount = await ingestPushPayload(user.id, {
      sender: "GTBank",
      body: PUSH.replaceAll("1234", "5678"),
      receivedAt: "2026-10-07T14:20:00.000Z",
      sourceId: "push-other-acct",
    });
    expect(otherAccount.status).toBe("created");

    const later = await ingestPushPayload(user.id, {
      sender: "GTBank",
      body: PUSH.replace("Bal:NGN76,550.00", "Bal:NGN10,000.00").replace("2026-10-07", "2026-10-10"),
      receivedAt: "2026-10-10T14:20:00.000Z",
      sourceId: "push-later",
    });
    expect(later.status).toBe("created");
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(3);
  });

  it("links a push to an earlier email of the same debit", async () => {
    const user = await db.user.create({ data: { email: "push-mail@test.dev" } });
    const email = await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "gmail",
      sourceTransactionId: "mail-3450",
      type: "DEBIT",
      amountMinor: 345_000n,
      currency: "NGN",
      transactionDate: new Date("2026-10-07T14:17:00.000Z"),
      description: "TRANSFER TO JANE DOE",
      accountLast4: "1234",
      confidence: 1,
    });
    expect(email.status).toBe("created");
    if (email.status !== "created") return;

    const push = await ingestPushPayload(user.id, {
      sender: "GTBank",
      body: PUSH,
      receivedAt: "2026-10-07T14:20:00.000Z",
      sourceId: "push-mail",
    });
    expect(push.status).toBe("duplicate");
    if (push.status !== "duplicate") return;
    expect(push.transactionId).toBe(email.transactionId);
    const sources = await db.transactionSource.findMany({ where: { transactionId: email.transactionId } });
    expect(sources.map((row) => row.source).sort()).toEqual(["gmail", "push"]);
  });
});
