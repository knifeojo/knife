import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { monthPeriod, recurring, summary } from "@/core/analytics";
import { pairAdvances, pairOwnTransfers } from "@/core/transfers";

let n = 0;
async function setup() {
  const u = await db.user.create({ data: { email: `adv-${++n}@test.dev` } });
  const acct = await db.account.create({
    data: { userId: u.id, institution: "Pesa", accountName: "Wallet", maskedAccountNumber: "****3333", holderName: "Ada Eze", currency: "NGN" },
  });
  return { userId: u.id, acct };
}

async function row(
  userId: string,
  accountId: string,
  data: { type: "DEBIT" | "CREDIT"; amountMinor: bigint; date: string; description: string; category: string; subcategory: string; currency?: string },
) {
  return db.transaction.create({
    data: {
      userId, accountId, source: "fixture",
      sourceTransactionId: `adv-${++n}`, fingerprint: `fp-adv-${++n}`,
      transactionDate: new Date(`${data.date}T12:00:00Z`),
      type: data.type, amountMinor: data.amountMinor, currency: data.currency ?? "NGN",
      description: data.description, category: data.category, subcategory: data.subcategory,
      classificationSource: "rule", classificationConfidence: 0.95,
    },
  });
}

describe("advance / repayment pairing", () => {
  it("pairs an equal same-account advance and repayment within 35 days and drops both from totals", async () => {
    const { userId, acct } = await setup();
    const credit = await row(userId, acct.id, {
      type: "CREDIT", amountMinor: 800_00n, date: "2026-03-05",
      description: "Acme advance", category: "Debt", subcategory: "Loan proceeds",
    });
    const fee = await row(userId, acct.id, {
      type: "DEBIT", amountMinor: 25_00n, date: "2026-03-05",
      description: "Acme advance fee", category: "Fees", subcategory: "Advance fee",
    });
    const debit = await row(userId, acct.id, {
      type: "DEBIT", amountMinor: 800_00n, date: "2026-03-20",
      description: "Acme advance repayment", category: "Debt", subcategory: "Loan repayment",
    });
    expect(await pairAdvances(userId)).toBe(1);
    const linked = await db.transaction.findUniqueOrThrow({ where: { id: credit.id } });
    expect(linked.transferPairId).toBe(debit.id);
    expect((await db.transaction.findUniqueOrThrow({ where: { id: debit.id } })).transferPairId).toBe(credit.id);
    expect((await db.transaction.findUniqueOrThrow({ where: { id: fee.id } })).transferPairId).toBeNull();
    const s = await summary(userId, monthPeriod(new Date("2026-03-15T12:00:00Z")));
    expect(s.income).toBe(0n);
    expect(s.expenses).toBe(25_00n);
  });

  it("leaves unmatched and unequal repayments as debt spending", async () => {
    const { userId, acct } = await setup();
    await row(userId, acct.id, {
      type: "CREDIT", amountMinor: 50_000_00n, date: "2026-03-02",
      description: "FairMoney disbursement", category: "Debt", subcategory: "Loan proceeds",
    });
    const repay = await row(userId, acct.id, {
      type: "DEBIT", amountMinor: 15_000_00n, date: "2026-03-03",
      description: "FairMoney repayment", category: "Debt", subcategory: "Loan repayment",
    });
    const late = await row(userId, acct.id, {
      type: "CREDIT", amountMinor: 200_00n, date: "2026-03-01",
      description: "Other advance", category: "Debt", subcategory: "Loan proceeds",
    });
    const tooLate = await row(userId, acct.id, {
      type: "DEBIT", amountMinor: 200_00n, date: "2026-04-10",
      description: "Other advance repayment", category: "Debt", subcategory: "Loan repayment",
    });
    expect(await pairOwnTransfers(userId)).toBe(0);
    expect((await db.transaction.findUniqueOrThrow({ where: { id: repay.id } })).transferPairId).toBeNull();
    expect((await db.transaction.findUniqueOrThrow({ where: { id: late.id } })).transferPairId).toBeNull();
    expect((await db.transaction.findUniqueOrThrow({ where: { id: tooLate.id } })).transferPairId).toBeNull();
    const s = await summary(userId, monthPeriod(new Date("2026-03-15T12:00:00Z")));
    expect(s.expenses).toBe(15_000_00n);
  });

  it("matches oldest-first when two advances share one amount", async () => {
    const { userId, acct } = await setup();
    const a1 = await row(userId, acct.id, {
      type: "CREDIT", amountMinor: 100_00n, date: "2026-03-01",
      description: "Advance one", category: "Debt", subcategory: "Loan proceeds",
    });
    const a2 = await row(userId, acct.id, {
      type: "CREDIT", amountMinor: 100_00n, date: "2026-03-10",
      description: "Advance two", category: "Debt", subcategory: "Loan proceeds",
    });
    const r1 = await row(userId, acct.id, {
      type: "DEBIT", amountMinor: 100_00n, date: "2026-03-08",
      description: "Repay one", category: "Debt", subcategory: "Loan repayment",
    });
    const r2 = await row(userId, acct.id, {
      type: "DEBIT", amountMinor: 100_00n, date: "2026-03-12",
      description: "Repay two", category: "Debt", subcategory: "Loan repayment",
    });
    expect(await pairAdvances(userId)).toBe(2);
    expect((await db.transaction.findUniqueOrThrow({ where: { id: a1.id } })).transferPairId).toBe(r1.id);
    expect((await db.transaction.findUniqueOrThrow({ where: { id: a2.id } })).transferPairId).toBe(r2.id);
  });

  it("pairs a Deel salary advance that straddles a month end", async () => {
    const { userId, acct } = await setup();
    const credit = await row(userId, acct.id, {
      type: "CREDIT", amountMinor: 1_500_00n, date: "2026-03-31",
      description: "Deel salary advance", category: "Debt", subcategory: "Loan proceeds", currency: "USD",
    });
    const debit = await row(userId, acct.id, {
      type: "DEBIT", amountMinor: 1_500_00n, date: "2026-04-01",
      description: "Deel advance repayment", category: "Debt", subcategory: "Loan repayment", currency: "USD",
    });
    expect(await pairAdvances(userId)).toBe(1);
    expect((await db.transaction.findUniqueOrThrow({ where: { id: credit.id } })).transferPairId).toBe(debit.id);
  });

  it("pairs a Deel advance when the repayment is dated the day before the credit", async () => {
    const { userId, acct } = await setup();
    const debit = await row(userId, acct.id, {
      type: "DEBIT", amountMinor: 1_500_00n, date: "2026-04-30",
      description: "Deel advance repayment", category: "Debt", subcategory: "Loan repayment", currency: "USD",
    });
    const credit = await row(userId, acct.id, {
      type: "CREDIT", amountMinor: 1_500_00n, date: "2026-05-01",
      description: "Deel salary advance", category: "Debt", subcategory: "Loan proceeds", currency: "USD",
    });
    expect(await pairAdvances(userId)).toBe(1);
    expect((await db.transaction.findUniqueOrThrow({ where: { id: credit.id } })).transferPairId).toBe(debit.id);
  });

  it("sends leftover unmatched Deel advances to Review and does not count them as income or spending", async () => {
    const { userId, acct } = await setup();
    await row(userId, acct.id, {
      type: "CREDIT", amountMinor: 1_500_00n, date: "2026-05-15",
      description: "Deel salary advance", category: "Debt", subcategory: "Loan proceeds", currency: "USD",
    });
    expect(await pairOwnTransfers(userId)).toBe(0);
    const leftover = await db.transaction.findFirstOrThrow({ where: { userId, description: "Deel salary advance" } });
    expect(leftover.transferPairId).toBeNull();
    expect(leftover.category).toBe("Own transfer");
    const { buildQuestions } = await import("@/core/review");
    const qs = await buildQuestions(userId);
    const advance = qs.find((q) => q.kind === "advance");
    expect(advance).toMatchObject({ totalCurrency: "USD", totalMinor: 1_500_00n });
    expect(advance?.prompt.startsWith("$1,500.00")).toBe(true);
    expect(advance?.options.find((o) => o.value === "debt")?.label).toBe("This is a real loan - count it as debt");
    const s = await summary(userId, monthPeriod(new Date("2026-05-20T12:00:00Z")));
    expect(s.income).toBe(0n);
    expect(s.expenses).toBe(0n);
  });

  it("does not treat a paired repayment as a recurring obligation", async () => {
    const { userId, acct } = await setup();
    for (const [creditDay, debitDay] of [["2026-01-05", "2026-01-20"], ["2026-02-05", "2026-02-18"], ["2026-03-05", "2026-03-19"]] as const) {
      await row(userId, acct.id, {
        type: "CREDIT", amountMinor: 800_00n, date: creditDay,
        description: "Acme advance", category: "Debt", subcategory: "Loan proceeds",
      });
      await row(userId, acct.id, {
        type: "DEBIT", amountMinor: 800_00n, date: debitDay,
        description: "Acme advance repayment", category: "Debt", subcategory: "Loan repayment",
      });
    }
    expect(await pairAdvances(userId)).toBe(3);
    const bills = await recurring(userId, new Date("2026-03-25T12:00:00Z"), "DEBIT");
    expect(bills.every((b) => b.category !== "Debt")).toBe(true);
  });
});
