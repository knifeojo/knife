import { describe, expect, it } from "vitest";
import { POST as sms } from "@/app/api/v1/alerts/sms/route";
import { POST as dismiss } from "@/app/api/v1/loans/cleared/route";
import { GET as overview } from "@/app/api/v1/overview/route";
import { assessAffordability, type AffordabilityData, type LenderActivity, type MonthFigures, type RegularItem } from "@/core/affordability";
import { closeReason, endedLongAgo, freedPerMonth, inferLoanDraft, isMerchantPayment, lenderOfRepayment, medianMinor, otherPersonTransfer, repaymentsStopped, type RepaymentRow } from "@/core/loan-cleared";
import { closeDueLoans, inferMissingLoans, loanClearedCards, recordLoanCleared, syncLoanMoments } from "@/core/loan-moments";
import { countRepayments, createLoan, isFinished, toManualLoan } from "@/core/loans";
import { issueSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";

const N = (naira: number) => BigInt(naira) * 100n;
let n = 0;

const row = (over: Partial<RepaymentRow> & Pick<RepaymentRow, "description">): RepaymentRow => ({
  date: new Date("2026-08-05T12:00:00Z"),
  amountMinor: N(12_000),
  merchantName: null,
  counterparty: null,
  category: "Debt",
  type: "DEBIT",
  ...over,
});

describe("freed amount and close rules", () => {
  it("uses the median of the last three repayments, then the instalment", () => {
    expect(medianMinor([])).toBeNull();
    expect(medianMinor([N(10), N(30)])).toBe(N(20));
    expect(freedPerMonth([N(10_000), N(18_000), N(12_000), N(15_000)], N(9_000))).toBe(N(15_000));
    expect(freedPerMonth([], N(9_000))).toBe(N(9_000));
    expect(freedPerMonth([], null)).toBe(0n);
  });

  it("treats a repayment as stopped 45 days after the expected next one", () => {
    const last = new Date("2026-01-01T00:00:00Z");
    const edge = new Date(last.getTime() + (30 + 45) * 86_400_000);
    expect(repaymentsStopped(last, edge)).toBe(false);
    expect(repaymentsStopped(last, new Date(edge.getTime() + 1))).toBe(true);
    expect(endedLongAgo(last, new Date(last.getTime() + 45 * 86_400_000))).toBe(false);
    expect(endedLongAgo(last, new Date(last.getTime() + 45 * 86_400_000 + 1))).toBe(true);
  });

  it("drops shop payments and transfers to someone else at the same provider", () => {
    expect(isMerchantPayment("POS PURCHASE AT SHOPRITE LEKKI")).toBe(true);
    expect(otherPersonTransfer("TO CARBON - ADA OJO", "Tunde Ade")).toBe(true);
    expect(otherPersonTransfer("TO RENMONEY - TUNDE ADE", "Tunde Ade")).toBe(false);
    expect(otherPersonTransfer("TO FAIRMONEY LOAN REPAYMENT", "Tunde Ade")).toBe(false);
    expect(lenderOfRepayment(row({ description: "POS PURCHASE AT SHOPRITE", merchantName: "Carbon" }), "Tunde Ade")).toBeUndefined();
    expect(lenderOfRepayment(row({ description: "TO CARBON - ADA OJO", merchantName: "Carbon" }), "Tunde Ade")).toBeUndefined();
    expect(lenderOfRepayment(row({ description: "TO RENMONEY - TUNDE ADE", merchantName: "Renmoney" }), "Tunde Ade")).toBe("Renmoney");
    expect(lenderOfRepayment(row({ description: "FAIRMONEY LOAN REPAYMENT", merchantName: "FairMoney" }), "Tunde Ade")).toBe("FairMoney");
    expect(lenderOfRepayment(row({ description: "PALMCREDIT REPAYMENT", merchantName: null }), "Tunde Ade")).toBe("PalmCredit");
    expect(lenderOfRepayment(row({ description: "FAIRMONEY LOAN REPAYMENT", category: "Shopping" }), "Tunde Ade")).toBeUndefined();
  });

  it("infers a closed loan only after repayments stop, and stays quiet when that was long ago", () => {
    const debits = [0, 1, 2].map((i) => ({ date: new Date(Date.UTC(2025, i, 5)), amountMinor: N(12_000) }));
    const now = new Date("2026-10-30T12:00:00Z");
    const draft = inferLoanDraft("FairMoney", debits, false, now);
    expect(draft).toMatchObject({ lender: "FairMoney", instalmentMinor: N(12_000), totalRepaidMinor: N(36_000), closed: true, silent: true });
    expect(inferLoanDraft("FairMoney", debits.slice(0, 2), false, now)).toBeNull();
    expect(inferLoanDraft("FairMoney", debits, true, now)?.closed).toBe(false);

    const recent = [8, 9, 10].map((month) => ({ date: new Date(Date.UTC(2026, month - 1, 5)), amountMinor: N(12_000) }));
    expect(inferLoanDraft("Renmoney", recent, false, new Date("2026-10-20T12:00:00Z"))).toMatchObject({ closed: false, silent: false });
  });

  it("closes a manual loan on a zero balance or a final instalment, and an inferred loan when repayments stop", () => {
    const now = new Date("2026-12-20T12:00:00Z");
    const last = new Date("2026-09-05T12:00:00Z");
    expect(closeReason({ source: "manual", outstandingMinor: N(50_000), instalmentsPaid: 2, instalmentsTotal: 6, lastRepayment: last, disbursementAfterLast: false, now })).toBeNull();
    expect(closeReason({ source: "manual", outstandingMinor: 0n, instalmentsPaid: 2, instalmentsTotal: 6, lastRepayment: last, disbursementAfterLast: false, now })).toBe("zero");
    expect(closeReason({ source: "manual", outstandingMinor: N(12_000), instalmentsPaid: 6, instalmentsTotal: 6, lastRepayment: null, disbursementAfterLast: false, now })).toBe("final");
    expect(closeReason({ source: "inferred", outstandingMinor: N(12_000), instalmentsPaid: null, instalmentsTotal: null, lastRepayment: last, disbursementAfterLast: false, now })).toBe("stopped");
    expect(closeReason({ source: "inferred", outstandingMinor: N(12_000), instalmentsPaid: null, instalmentsTotal: null, lastRepayment: last, disbursementAfterLast: true, now })).toBeNull();
  });
});

async function seed(name = "Tunde Ade") {
  const user = await db.user.create({ data: { email: `cleared-${++n}@ledger.test`, name } });
  const account = await db.account.create({
    data: {
      userId: user.id,
      institution: "Example Bank",
      accountName: "Example NGN",
      maskedAccountNumber: "****0001",
      currency: "NGN",
      balanceMinor: N(500_000),
    },
  });
  return { user, account };
}

async function tx(
  userId: string,
  accountId: string,
  data: { date: string; amount: number; description: string; merchant?: string | null; type?: "DEBIT" | "CREDIT"; category?: string },
) {
  return db.transaction.create({
    data: {
      userId,
      accountId,
      source: "fixture",
      sourceTransactionId: `lc-${++n}`,
      fingerprint: `lc-fp-${++n}`,
      transactionDate: new Date(`${data.date}T12:00:00Z`),
      type: data.type ?? "DEBIT",
      amountMinor: N(data.amount),
      currency: "NGN",
      description: data.description,
      merchantName: data.merchant === undefined ? data.description : data.merchant,
      category: data.category ?? "Debt",
      subcategory: "Loan repayment",
      classificationSource: "rule",
      classificationConfidence: 0.9,
    },
  });
}

describe("inferred loans", () => {
  it("creates a loan from three lender debits and skips shops, other people, and short runs", async () => {
    const { user, account } = await seed();
    const now = new Date("2026-10-20T12:00:00Z");
    for (const date of ["2026-08-05", "2026-09-05", "2026-10-05"]) {
      await tx(user.id, account.id, { date, amount: 12_000, description: "TO RENMONEY - TUNDE ADE", merchant: "Renmoney" });
      await tx(user.id, account.id, { date, amount: 4_000, description: "POS PURCHASE AT SHOPRITE", merchant: "Carbon" });
      await tx(user.id, account.id, { date, amount: 8_000, description: "TO CARBON - ADA OJO", merchant: "Carbon" });
    }
    await tx(user.id, account.id, { date: "2026-08-05", amount: 5_000, description: "PALMCREDIT REPAYMENT", merchant: "PalmCredit" });
    await tx(user.id, account.id, { date: "2026-09-05", amount: 5_000, description: "PALMCREDIT REPAYMENT", merchant: "PalmCredit" });
    for (const date of ["2025-01-05", "2025-02-05", "2025-03-05"]) {
      await tx(user.id, account.id, { date, amount: 9_000, description: "CARBON LOAN REPAYMENT", merchant: "Carbon" });
    }
    await tx(user.id, account.id, { date: "2025-04-01", amount: 40_000, description: "CARBON DISBURSEMENT", merchant: "Carbon", type: "CREDIT" });

    expect(await inferMissingLoans(user.id, now)).toBe(2);
    const loans = await db.loan.findMany({ where: { userId: user.id }, orderBy: { lender: "asc" } });
    expect(loans.map((loan) => loan.lender)).toEqual(["Carbon", "Renmoney"]);
    const ren = loans.find((loan) => loan.lender === "Renmoney")!;
    expect(ren).toMatchObject({ source: "inferred", status: "open", instalmentMinor: N(12_000), totalRepaidMinor: N(36_000), outstandingMinor: N(12_000) });
    expect(ren.firstPayment?.toISOString().slice(0, 10)).toBe("2026-08-05");
    expect(ren.balanceAsOf.toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(loans.find((loan) => loan.lender === "Carbon")!.status).toBe("open");
    expect(await db.loanClearedEvent.count({ where: { userId: user.id } })).toBe(0);
    expect(await inferMissingLoans(user.id, now)).toBe(0);
  });

  it("marks a loan that had already ended as closed without a card, and fires the moment once when one ends later", async () => {
    const old = await seed("Ada Ojo");
    for (const date of ["2025-06-05", "2025-07-05", "2025-08-05"]) {
      await tx(old.user.id, old.account.id, { date, amount: 12_000, description: "FAIRMONEY LOAN REPAYMENT", merchant: "FairMoney" });
    }
    await syncLoanMoments(old.user.id, new Date("2026-10-30T12:00:00Z"));
    await syncLoanMoments(old.user.id, new Date("2026-10-30T12:00:00Z"));
    const silent = await db.loan.findFirstOrThrow({ where: { userId: old.user.id } });
    expect(silent).toMatchObject({ lender: "FairMoney", source: "inferred", status: "closed", totalRepaidMinor: N(36_000), outstandingMinor: 0n });
    const silentEvent = await db.loanClearedEvent.findUniqueOrThrow({ where: { loanId: silent.id } });
    expect(silentEvent.silent).toBe(true);
    expect(silentEvent.freedPerMonthMinor).toBe(N(12_000));
    expect(await loanClearedCards(old.user.id)).toEqual([]);
    expect(isFinished(toManualLoan(silent), new Date("2026-10-30T12:00:00Z"))).toBe(true);

    const live = await seed();
    const amounts = [10_000, 18_000, 12_000, 15_000];
    const dates = ["2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05"];
    for (let i = 0; i < dates.length; i++) {
      await tx(live.user.id, live.account.id, { date: dates[i], amount: amounts[i], description: "RENMONEY MFB LOAN REPAYMENT", merchant: "Renmoney" });
    }
    await inferMissingLoans(live.user.id, new Date("2026-09-20T12:00:00Z"));
    const open = await db.loan.findFirstOrThrow({ where: { userId: live.user.id } });
    expect(open.status).toBe("open");
    expect(await db.loanClearedEvent.count({ where: { userId: live.user.id } })).toBe(0);

    await closeDueLoans(live.user.id, new Date("2026-12-20T12:00:00Z"));
    await closeDueLoans(live.user.id, new Date("2027-02-01T12:00:00Z"));
    const closed = await db.loan.findFirstOrThrow({ where: { id: open.id } });
    expect(closed.status).toBe("closed");
    expect(closed.totalRepaidMinor).toBe(N(55_000));
    const event = await db.loanClearedEvent.findUniqueOrThrow({ where: { loanId: open.id } });
    expect(event).toMatchObject({ silent: false, freedPerMonthMinor: N(15_000), totalRepaidMinor: N(55_000), lender: "Renmoney" });
    const again = await recordLoanCleared(live.user.id, closed);
    expect(again.id).toBe(event.id);
    expect(await db.loanClearedEvent.count({ where: { loanId: open.id } })).toBe(1);
    expect((await loanClearedCards(live.user.id)).map((card) => card.id)).toEqual([event.id]);

    const { token } = await issueSession(live.user.id);
    const home = await overview(new Request("http://localhost/api/v1/overview", { headers: { authorization: `Bearer ${token}` } }));
    const body = (await home.json()) as { leftMinor: string; projectedLeftMinor: string; loanCleared: { id: string }[] };
    expect(body.loanCleared.map((card) => card.id)).toEqual([event.id]);
    expect(BigInt(body.projectedLeftMinor) - BigInt(body.leftMinor)).toBe(N(15_000));
    const past = await overview(new Request("http://localhost/api/v1/overview?month=2020-01", { headers: { authorization: `Bearer ${token}` } }));
    const pastBody = (await past.json()) as { leftMinor: string; projectedLeftMinor: string };
    expect(pastBody.projectedLeftMinor).toBe(pastBody.leftMinor);

    const hidden = await dismiss(new Request("http://localhost/api/v1/loans/cleared", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: event.id }),
    }));
    expect(hidden.status).toBe(200);
    expect(await loanClearedCards(live.user.id)).toEqual([]);
    expect(await db.loanClearedEvent.count({ where: { loanId: open.id } })).toBe(1);
    const repeat = await dismiss(new Request("http://localhost/api/v1/loans/cleared", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: event.id }),
    }));
    expect(repeat.status).toBe(404);

    const paidOff = { ...toManualLoan(closed), closedAt: new Date("2026-10-29T09:00:00Z") };
    const purchase = { amountMinor: N(1_800_000), description: "a car deposit", horizon: { kind: "month_end" } as const };
    const without = assessAffordability(affordFixture(), purchase, new Date("2026-11-10T09:00:00Z"));
    const freed = assessAffordability(affordFixture([paidOff]), purchase, new Date("2026-11-10T09:00:00Z"));
    expect(without.inputs.obligations.map((item) => item.name)).toContain("Renmoney");
    expect(freed.inputs.obligations.map((item) => item.name)).toEqual(["Rent"]);
    expect(freed.inputs.monthlySurplusMinor).toBe(without.inputs.monthlySurplusMinor + N(15_000));
    expect(freed.advice.some((line) => line.subject === "Renmoney")).toBe(false);
  });

  it("fires the cleared moment once from a status text or a repayment that brings the balance to zero", async () => {
    resetRateLimits();
    const { user, account } = await seed();
    const { token } = await issueSession(user.id);
    const loan = await createLoan(user.id, {
      lender: "Renmoney",
      outstandingMinor: N(18_500),
      instalmentMinor: N(18_500),
      instalmentsPaid: 11,
      instalmentsTotal: 12,
      nextDueDate: new Date("2026-10-15T00:00:00Z"),
      endDate: null,
      notes: null,
    });
    const post = (sourceId: string) => sms(new Request("http://localhost/api/v1/alerts/sms", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        sender: "Renmoney",
        body: "Renmoney: Your loan has been cleared. Outstanding balance NGN0.00.",
        receivedAt: "2026-10-23T09:00:00.000Z",
        sourceId,
      }),
    }));
    expect((await (await post("cleared-once")).json()).results[0].status).toBe("loan_update");
    expect((await (await post("cleared-again")).json()).results[0].status).toBe("review");
    expect(await db.loanClearedEvent.count({ where: { loanId: loan.id } })).toBe(1);
    expect((await db.loanClearedEvent.findUniqueOrThrow({ where: { loanId: loan.id } })).silent).toBe(false);

    const carbon = await createLoan(user.id, {
      lender: "Carbon",
      outstandingMinor: N(9_000),
      instalmentMinor: N(9_000),
      instalmentsPaid: null,
      instalmentsTotal: null,
      nextDueDate: null,
      endDate: null,
      notes: null,
    }, new Date("2026-09-01T00:00:00Z"));
    await tx(user.id, account.id, { date: "2026-10-02", amount: 9_000, description: "CARBON LOAN REPAYMENT", merchant: "Carbon" });
    const counted = await countRepayments(user.id, carbon.id);
    expect(counted?.loan.status).toBe("closed");
    expect(counted?.loan.outstandingMinor).toBe(0n);
    expect(await countRepayments(user.id, carbon.id)).toBeNull();
    const event = await db.loanClearedEvent.findUniqueOrThrow({ where: { loanId: carbon.id } });
    expect(event.freedPerMonthMinor).toBe(N(9_000));
    expect(event.silent).toBe(false);
    expect(await db.loanClearedEvent.count({ where: { loanId: carbon.id } })).toBe(1);
  });

  it("does not close a manual loan just because the repayments stopped", async () => {
    const { user, account } = await seed();
    const loan = await createLoan(user.id, {
      lender: "PalmCredit",
      outstandingMinor: N(40_000),
      instalmentMinor: N(10_000),
      instalmentsPaid: 2,
      instalmentsTotal: 6,
      nextDueDate: new Date("2026-04-05T00:00:00Z"),
      endDate: null,
      notes: null,
    });
    for (const date of ["2026-01-05", "2026-02-05", "2026-03-05"]) {
      await tx(user.id, account.id, { date, amount: 10_000, description: "PALMCREDIT REPAYMENT", merchant: "PalmCredit" });
    }
    await closeDueLoans(user.id, new Date("2026-10-30T12:00:00Z"));
    expect((await db.loan.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe("open");
    expect(await db.loanClearedEvent.count({ where: { userId: user.id } })).toBe(0);
  });
});

const month = (label: string, income: number, spending: number, loans = 0): MonthFigures => ({
  label, incomeMinor: N(income), spendingMinor: N(spending), loanRepaymentsMinor: N(loans), categories: [], partial: false, days: 30,
});
const regular = (name: string, category: string, naira: number, last: string, next: string): RegularItem => ({
  name, category, amountMinor: N(naira), lastDate: new Date(last), nextExpected: new Date(next),
});
const lender = (name: string, repayments: [string, number][]): LenderActivity => ({
  name,
  repayments: repayments.map(([date, amount]) => ({ date: new Date(date), amountMinor: N(amount) })),
  proceeds: [],
});

function affordFixture(loans: AffordabilityData["loans"] = []): AffordabilityData {
  return {
    cash: { minor: N(2_000_000), asOf: new Date("2026-11-10T09:00:00Z"), accounts: 1 },
    otherCurrencies: [],
    months: [month("October 2026", 1_200_000, 700_000, 15_000), month("September 2026", 1_200_000, 700_000, 15_000), month("August 2026", 1_200_000, 700_000, 15_000)],
    obligations: [
      regular("Rent", "Housing", 250_000, "2026-10-25T09:00:00Z", "2026-11-25T09:00:00Z"),
      regular("Renmoney", "Debt", 15_000, "2026-10-05T09:00:00Z", "2026-11-05T09:00:00Z"),
    ],
    income: [regular("Acme Technologies", "Income", 1_200_000, "2026-10-24T09:00:00Z", "2026-11-24T09:00:00Z")],
    lenders: [lender("Renmoney", [["2026-08-05T09:00:00Z", 15_000], ["2026-09-05T09:00:00Z", 15_000], ["2026-10-05T09:00:00Z", 15_000]])],
    oneOffs: [],
    oneOffsSince: new Date("2026-06-30T23:00:00Z"),
    loans,
  };
}
