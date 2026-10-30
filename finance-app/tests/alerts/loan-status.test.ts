import { beforeAll, describe, expect, it } from "vitest";
import { POST as sms } from "@/app/api/v1/alerts/sms/route";
import { parseLoanStatus } from "@/core/alerts/loan-status";
import { createLoan } from "@/core/loans";
import { issueSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";

const N = (naira: number) => BigInt(naira) * 100n;
const STATUS =
  "Renmoney: Your loan outstanding balance is NGN150,000.00. Instalment 3 of 12. Amount due NGN18,500.00. Due date 15 Nov 2026.";
const OVERDUE = "Renmoney: Your loan is overdue. Please pay soon.";
const CLEARED = "Renmoney: Your loan has been cleared. Outstanding balance NGN0.00.";
const PAYMENT = "Acct:******1234\nAmt:NGN3,450.00 DR\nDesc:POS PURCHASE\nBal:NGN10,000.00";

function post(body: unknown, token: string) {
  return new Request("http://localhost/api/v1/alerts/sms", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("loan status SMS", () => {
  let token: string;
  let userId: string;

  beforeAll(async () => {
    resetRateLimits();
    const user = await db.user.create({ data: { email: "loan-status@test.dev" } });
    userId = user.id;
    token = (await issueSession(user.id)).token;
  });

  it("tells a loan update from a payment", () => {
    const parsed = parseLoanStatus("Renmoney", STATUS);
    expect(parsed?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(parsed?.outstandingMinor).toBe(N(150_000));
    expect(parsed?.amountDueMinor).toBe(N(18_500));
    expect(parsed?.instalmentsPaid).toBe(2);
    expect(parsed?.instalmentTotal).toBe(12);
    expect(parsed?.nextDueDate?.toISOString()).toBe("2026-11-15T00:00:00.000Z");
    expect(parseLoanStatus("Renmoney", PAYMENT)).toBeNull();
    expect(parseLoanStatus("Renmoney", "Congratulations! You have a loan offer up to N300,000. Dial *894*11#")).toBeNull();
    expect(parseLoanStatus("Renmoney", "Your OTP is 482193. Do not share this code.")).toBeNull();
    expect(parseLoanStatus("Renmoney", OVERDUE)?.confidence).toBeLessThan(0.8);
  });

  it("updates the matching loan, keeps an audit row, and does not post a transaction", async () => {
    const loan = await createLoan(userId, {
      lender: "Renmoney",
      outstandingMinor: N(200_000),
      instalmentMinor: null,
      instalmentsPaid: null,
      instalmentsTotal: null,
      nextDueDate: null,
      endDate: null,
      notes: null,
    });
    const before = await db.transaction.count({ where: { userId } });
    const first = await sms(post({ sender: "Renmoney", body: STATUS, receivedAt: "2026-10-20T09:00:00.000Z", sourceId: "loan-sms-1" }, token));
    expect(first.status).toBe(200);
    expect((await first.json()).results[0]).toMatchObject({ status: "loan_update", applied: true, loanId: loan.id });
    const updated = await db.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(updated.outstandingMinor).toBe(N(150_000));
    expect(updated.instalmentMinor).toBe(N(18_500));
    expect(updated.instalmentsPaid).toBe(2);
    expect(updated.instalmentsTotal).toBe(12);
    expect(updated.nextDueDate?.toISOString()).toBe("2026-11-15T00:00:00.000Z");
    expect(updated.status).toBe("open");
    expect(await db.transaction.count({ where: { userId } })).toBe(before);
    expect(await db.loanUpdate.count({ where: { userId, sourceId: "loan-sms-1", applied: true } })).toBe(1);

    const again = await sms(post({ sender: "Renmoney", body: STATUS, receivedAt: "2026-10-20T09:00:00.000Z", sourceId: "loan-sms-1" }, token));
    expect((await again.json()).results[0].status).toBe("loan_update");
    expect(await db.loanUpdate.count({ where: { userId, sourceId: "loan-sms-1" } })).toBe(1);
    expect((await db.loan.findUniqueOrThrow({ where: { id: loan.id } })).outstandingMinor).toBe(N(150_000));
  });

  it("sends an unmatched or low-confidence text to Review as a loan update", async () => {
    const before = await db.transaction.count({ where: { userId } });
    const unmatched = await sms(post({ sender: "FairMoney", body: "FairMoney: Your loan outstanding balance is NGN10,000.00. Due date 01 Dec 2026.", receivedAt: "2026-10-21T09:00:00.000Z", sourceId: "loan-sms-none" }, token));
    expect((await unmatched.json()).results[0].status).toBe("review");
    const row = await db.unparsedAlert.findFirst({ where: { userId, sender: "FairMoney" } });
    expect(row?.reason).toBe("loan_update");
    expect(await db.loanUpdate.count({ where: { userId, sourceId: "loan-sms-none", applied: false } })).toBe(1);

    const low = await sms(post({ sender: "Renmoney", body: OVERDUE, receivedAt: "2026-10-22T09:00:00.000Z", sourceId: "loan-sms-low" }, token));
    expect((await low.json()).results[0].status).toBe("review");
    expect((await db.loan.findFirstOrThrow({ where: { userId, lender: "Renmoney" } })).outstandingMinor).toBe(N(150_000));

    const cleared = await sms(post({ sender: "Renmoney", body: CLEARED, receivedAt: "2026-10-23T09:00:00.000Z", sourceId: "loan-sms-cleared" }, token));
    expect((await cleared.json()).results[0].status).toBe("loan_update");
    const closed = await db.loan.findFirstOrThrow({ where: { userId, lender: "Renmoney" } });
    expect(closed.status).toBe("closed");
    expect(closed.outstandingMinor).toBe(0n);
    expect(await db.transaction.count({ where: { userId } })).toBe(before);
  });
});
