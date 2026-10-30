import { describe, expect, it } from "vitest";
import { POST as sms } from "@/app/api/v1/alerts/sms/route";
import { POST as dismiss } from "@/app/api/v1/loans/cleared/route";
import { GET as overview } from "@/app/api/v1/overview/route";
import { assessAffordability, type AffordabilityData, type LenderActivity, type MonthFigures, type RegularItem } from "@/core/affordability";
import { closeReason, closedRecently, endedLongAgo, freedPerMonth, groupLenderRepayments, inferLoanDraft, isLumpSum, isMerchantPayment, isOwnName, lenderOfRepayment, medianMinor, otherPersonTransfer, repaymentOverdue, repaymentsStopped, type RepaymentRow } from "@/core/loan-cleared";
import { answerQuestion, buildQuestions } from "@/core/review";
import { backfillRecentCleared, closeDueLoans, inferMissingLoans, loanClearedCards, recordLoanCleared, syncLoanMoments } from "@/core/loan-moments";
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
    expect(otherPersonTransfer("TO CARBON - BOLA KEMI", "Tunde Ade")).toBe(true);
    expect(otherPersonTransfer("TO RENMONEY - TUNDE ADE", "Tunde Ade")).toBe(false);
    expect(otherPersonTransfer("TO FAIRMONEY LOAN REPAYMENT", "Tunde Ade")).toBe(false);
    expect(isOwnName("TUNDE NWOSU", "Tunde")).toBe(true);
    expect(isOwnName("TUNDE NWOSU", "T. Nwosu")).toBe(true);
    expect(isOwnName("TUNDE CHINEDU NWOSU", "T Nwosu")).toBe(true);
    expect(isOwnName("BOLA KEMI", "Tunde Nwosu")).toBe(false);
    expect(otherPersonTransfer("TO RENMONEY - TUNDE NWOSU", "Tunde")).toBe(false);
    expect(otherPersonTransfer("TO RENMONEY - TUNDE NWOSU", ["Guest", "T. Nwosu"])).toBe(false);
    expect(otherPersonTransfer("TO CARBON - BOLA KEMI", "T. Nwosu")).toBe(true);
    expect(lenderOfRepayment(row({ description: "POS PURCHASE AT SHOPRITE", merchantName: "Carbon" }), "Tunde Ade")).toBeUndefined();
    expect(lenderOfRepayment(row({ description: "TO CARBON - BOLA KEMI", merchantName: "Carbon" }), "Tunde Ade")).toBeUndefined();
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
    const base = { instalmentsPaid: null, instalmentsTotal: null, lastRepayment: last, lumpSum: false, disbursementAfterLast: false, now };
    expect(closeReason({ ...base, source: "manual", outstandingMinor: N(50_000), instalmentsPaid: 2, instalmentsTotal: 6 })).toBeNull();
    expect(closeReason({ ...base, source: "manual", outstandingMinor: 0n, instalmentsPaid: 2, instalmentsTotal: 6 })).toBe("zero");
    expect(closeReason({ ...base, source: "manual", outstandingMinor: N(12_000), instalmentsPaid: 6, instalmentsTotal: 6, lastRepayment: null })).toBe("final");
    expect(closeReason({ ...base, source: "inferred", outstandingMinor: N(12_000) })).toBe("stopped");
    expect(closeReason({ ...base, source: "inferred", outstandingMinor: N(12_000), disbursementAfterLast: true })).toBeNull();
    const soon = new Date("2026-10-01T12:00:00Z");
    const settled = new Date("2026-10-20T12:00:00Z");
    expect(isLumpSum([N(70_000), N(100_000), N(150_000), N(400_000)])).toBe(true);
    expect(isLumpSum([N(100_000), N(100_000), N(240_000)])).toBe(false);
    expect(isLumpSum([N(100_000), N(100_000), N(250_000)])).toBe(true);
    expect(freedPerMonth([N(80_000), N(100_000), N(120_000), N(400_000)], null)).toBe(N(100_000));
    expect(closeReason({ ...base, source: "inferred", outstandingMinor: null, lastRepayment: new Date("2026-09-05T12:00:00Z"), lumpSum: true, now: soon })).toBeNull();
    expect(closeReason({ ...base, source: "inferred", outstandingMinor: null, lastRepayment: new Date("2026-09-05T12:00:00Z"), lumpSum: true, now: settled })).toBe("lump_sum");
    expect(closeReason({ ...base, source: "inferred", outstandingMinor: null, lastRepayment: new Date("2026-09-05T12:00:00Z"), lumpSum: true, disbursementAfterLast: true, now: settled })).toBeNull();
  });

  it("keeps a repeated beneficiary that does not match the profile, and drops a one-off", () => {
    const self = "Tunde Nwosu";
    const other = (date: string) => row({ description: "TO CARBON - BOLA KEMI", merchantName: "Carbon", date: new Date(`${date}T12:00:00Z`) });
    const two = groupLenderRepayments([other("2026-08-05"), other("2026-09-05")], self);
    expect(two.get("Carbon")).toBeUndefined();
    const three = groupLenderRepayments([other("2026-08-05"), other("2026-09-05"), other("2026-10-05")], self);
    expect(three.get("Carbon")).toHaveLength(3);
    const now = new Date("2026-10-30T12:00:00Z");
    expect(closedRecently(new Date(now.getTime() - 14 * 86_400_000), now)).toBe(true);
    expect(closedRecently(new Date(now.getTime() - 14 * 86_400_000 - 1), now)).toBe(false);
    const expected = new Date("2026-10-01T00:00:00Z");
    expect(repaymentOverdue(expected, new Date(expected.getTime() + 7 * 86_400_000))).toBe(false);
    expect(repaymentOverdue(expected, new Date(expected.getTime() + 7 * 86_400_000 + 1))).toBe(true);
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
  data: { date: string; amount: number; description: string; merchant?: string | null; counterparty?: string | null; type?: "DEBIT" | "CREDIT"; category?: string },
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
      counterparty: data.counterparty ?? null,
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
    }
    for (const date of ["2026-08-05", "2026-09-05"]) {
      await tx(user.id, account.id, { date, amount: 8_000, description: "TO CARBON - BOLA KEMI", merchant: "Carbon" });
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
    expect(ren).toMatchObject({ source: "inferred", status: "open", instalmentMinor: N(12_000), totalRepaidMinor: N(36_000), outstandingMinor: null });
    expect(ren.firstPayment?.toISOString().slice(0, 10)).toBe("2026-08-05");
    expect(ren.balanceAsOf.toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(loans.find((loan) => loan.lender === "Carbon")!.status).toBe("open");
    expect(await db.loanClearedEvent.count({ where: { userId: user.id } })).toBe(0);
    expect(await inferMissingLoans(user.id, now)).toBe(0);
  });

  it("marks a loan that had already ended as closed without a card, and fires the moment once when one ends later", async () => {
    const old = await seed("Chioma Balogun");
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

  it("treats TO LENDER - FULL NAME as the user when the stored name is only part of it", async () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const dates = ["2026-08-05", "2026-09-05", "2026-10-05"];

    const partial = await seed("Tunde");
    for (const date of dates) {
      await tx(partial.user.id, partial.account.id, { date, amount: 11_000, description: "TO RENMONEY - TUNDE NWOSU", merchant: "Renmoney" });
    }
    expect(await inferMissingLoans(partial.user.id, now)).toBe(1);
    expect(await db.loan.findFirstOrThrow({ where: { userId: partial.user.id } })).toMatchObject({ lender: "Renmoney", source: "inferred" });

    const holder = await seed("Guest");
    await db.account.update({ where: { id: holder.account.id }, data: { holderName: "T NWOSU" } });
    for (const date of dates) {
      await tx(holder.user.id, holder.account.id, { date, amount: 11_000, description: "TO FAIRMONEY - TUNDE NWOSU", merchant: "FairMoney" });
    }
    expect((await db.loan.findMany({ where: { userId: holder.user.id } })).map((loan) => loan.lender)).toEqual([]);
    expect(await inferMissingLoans(holder.user.id, now)).toBe(1);
    expect(await db.loan.findFirstOrThrow({ where: { userId: holder.user.id } })).toMatchObject({ lender: "FairMoney", source: "inferred" });

    const onboarded = await seed("T");
    await db.person.create({ data: { userId: onboarded.user.id, displayName: "Tunde Nwosu", relationship: "me" } });
    for (const date of dates) {
      await tx(onboarded.user.id, onboarded.account.id, { date, amount: 11_000, description: "TO PALMCREDIT - TUNDE NWOSU", merchant: "PalmCredit" });
    }
    expect(await inferMissingLoans(onboarded.user.id, now)).toBe(1);

    const credit = await seed("Guest");
    await tx(credit.user.id, credit.account.id, {
      date: "2026-07-01", amount: 20_000, description: "NIP FROM TUNDE NWOSU", merchant: null, counterparty: "Tunde Nwosu", type: "CREDIT", category: "Own transfer",
    });
    for (const date of dates) {
      await tx(credit.user.id, credit.account.id, { date, amount: 11_000, description: "TO CARBON - TUNDE NWOSU", merchant: "Carbon" });
    }
    expect(await inferMissingLoans(credit.user.id, now)).toBe(1);
    expect(await db.loan.findFirstOrThrow({ where: { userId: credit.user.id } })).toMatchObject({ lender: "Carbon" });

    const repeated = await seed("Tunde Nwosu");
    for (const date of dates) {
      await tx(repeated.user.id, repeated.account.id, { date, amount: 7_000, description: "TO CARBON - BOLA KEMI", merchant: "Carbon" });
    }
    await tx(repeated.user.id, repeated.account.id, { date: "2026-08-05", amount: 4_000, description: "TO PALMCREDIT - SEYI BALOGUN", merchant: "PalmCredit" });
    await tx(repeated.user.id, repeated.account.id, { date: "2026-09-05", amount: 4_000, description: "TO PALMCREDIT - SEYI BALOGUN", merchant: "PalmCredit" });
    expect(await inferMissingLoans(repeated.user.id, now)).toBe(1);
    const lenders = (await db.loan.findMany({ where: { userId: repeated.user.id } })).map((loan) => loan.lender);
    expect(lenders).toEqual(["Carbon"]);
  });

  it("fires Loan cleared once for a loan closed in the last 14 days that never had a moment", async () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const { user } = await seed("Chioma Balogun");
    const fields = {
      lender: "Renmoney" as const,
      outstandingMinor: 0n,
      instalmentMinor: N(15_000),
      instalmentsPaid: null,
      instalmentsTotal: null,
      nextDueDate: null,
      endDate: null,
      notes: null,
    };
    const recent = await createLoan(user.id, fields);
    await db.loan.update({ where: { id: recent.id }, data: { status: "closed", closedAt: new Date(now.getTime() - 5 * 86_400_000) } });
    const stale = await createLoan(user.id, { ...fields, lender: "FairMoney" });
    await db.loan.update({ where: { id: stale.id }, data: { status: "closed", closedAt: new Date(now.getTime() - 20 * 86_400_000) } });

    expect(await backfillRecentCleared(user.id, now)).toBe(1);
    const event = await db.loanClearedEvent.findUniqueOrThrow({ where: { loanId: recent.id } });
    expect(event.silent).toBe(false);
    expect(await db.loanClearedEvent.findUnique({ where: { loanId: stale.id } })).toBeNull();
    expect(await syncLoanMoments(user.id, now)).toBeUndefined();
    expect(await db.loanClearedEvent.count({ where: { userId: user.id } })).toBe(1);
  });

  it("asks if an inferred loan is paid off once a repayment is more than 7 days late", async () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const day = 86_400_000;
    const last = new Date(now.getTime() - 40 * day);
    const { user, account } = await seed("Tunde Nwosu");
    for (const when of [last.getTime() - 60 * day, last.getTime() - 30 * day, last.getTime()]) {
      await tx(user.id, account.id, { date: new Date(when).toISOString().slice(0, 10), amount: 13_000, description: "TO RENMONEY - TUNDE NWOSU", merchant: "Renmoney" });
    }
    expect(await inferMissingLoans(user.id, now)).toBe(1);
    const loan = await db.loan.findFirstOrThrow({ where: { userId: user.id } });
    expect(loan.outstandingMinor).toBeNull();
    expect(loan.status).toBe("open");

    const notYet = new Date(last.getTime() + 36 * day);
    expect((await buildQuestions(user.id, undefined, notYet)).some((q) => q.kind === "loan")).toBe(false);

    const asked = (await buildQuestions(user.id, undefined, now)).find((q) => q.kind === "loan");
    expect(asked).toMatchObject({ title: "Is your Renmoney loan paid off?", key: loan.id });
    expect(asked?.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(asked?.prompt).toContain("13,000");

    expect(await answerQuestion(user.id, "loan", loan.id, "no", undefined, now)).toBe(0);
    expect((await db.loan.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe("open");
    expect((await buildQuestions(user.id, undefined, new Date(now.getTime() + 29 * day))).some((q) => q.kind === "loan")).toBe(false);
    expect((await buildQuestions(user.id, undefined, new Date(now.getTime() + 31 * day))).some((q) => q.kind === "loan")).toBe(true);

    expect(await answerQuestion(user.id, "loan", loan.id, "yes", undefined, new Date(now.getTime() + 31 * day))).toBe(1);
    const closed = await db.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(closed).toMatchObject({ status: "closed", outstandingMinor: 0n });
    const event = await db.loanClearedEvent.findUniqueOrThrow({ where: { loanId: loan.id } });
    expect(event).toMatchObject({ silent: false, freedPerMonthMinor: N(13_000), lender: "Renmoney" });
    expect(await db.loanUpdate.findFirstOrThrow({ where: { loanId: loan.id, applied: true } })).toMatchObject({ status: "closed", channel: "review" });
    expect(await answerQuestion(user.id, "loan", loan.id, "yes", undefined, new Date(now.getTime() + 31 * day))).toBe(1);
    expect(await db.loanClearedEvent.count({ where: { loanId: loan.id } })).toBe(1);
    expect(await db.loanUpdate.count({ where: { loanId: loan.id } })).toBe(1);
    expect((await buildQuestions(user.id, undefined, new Date(now.getTime() + 40 * day))).some((q) => q.kind === "loan")).toBe(false);
  });

  it("closes an inferred loan when a payoff is at least 2.5× the instalment and nothing follows", async () => {
    const early = new Date("2026-10-01T12:00:00Z");
    const later = new Date("2026-10-20T12:00:00Z");
    const paid = [
      ["2026-06-05", 80_000],
      ["2026-07-05", 100_000],
      ["2026-08-05", 120_000],
      ["2026-09-05", 400_000],
    ] as const;
    const { user, account } = await seed("Tunde Nwosu");
    for (const [date, amount] of paid) {
      await tx(user.id, account.id, { date, amount, description: "TO RENMONEY - TUNDE NWOSU", merchant: "Renmoney" });
    }
    expect(await inferMissingLoans(user.id, early)).toBe(1);
    const open = await db.loan.findFirstOrThrow({ where: { userId: user.id } });
    expect(open).toMatchObject({ status: "open", outstandingMinor: null, instalmentMinor: N(100_000) });
    expect((await buildQuestions(user.id, undefined, early)).some((q) => q.kind === "loan")).toBe(false);

    await closeDueLoans(user.id, later);
    const closed = await db.loan.findFirstOrThrow({ where: { id: open.id } });
    expect(closed).toMatchObject({ status: "closed", outstandingMinor: 0n });
    const event = await db.loanClearedEvent.findUniqueOrThrow({ where: { loanId: open.id } });
    expect(event).toMatchObject({ silent: false, freedPerMonthMinor: N(100_000) });
    await syncLoanMoments(user.id, later);
    expect(await db.loanClearedEvent.count({ where: { loanId: open.id } })).toBe(1);
    expect((await buildQuestions(user.id, undefined, later)).some((q) => q.kind === "loan")).toBe(false);

    const followed = await seed("Tunde Nwosu");
    for (const [date, amount] of paid) {
      await tx(followed.user.id, followed.account.id, { date, amount, description: "TO RENMONEY - TUNDE NWOSU", merchant: "Renmoney" });
    }
    await tx(followed.user.id, followed.account.id, { date: "2026-09-20", amount: 90_000, description: "TO RENMONEY - TUNDE NWOSU", merchant: "Renmoney" });
    expect(await inferMissingLoans(followed.user.id, later)).toBe(1);
    expect((await db.loan.findFirstOrThrow({ where: { userId: followed.user.id } })).status).toBe("open");

    const almost = await seed("Tunde Nwosu");
    for (const [date, amount] of [["2026-06-05", 100_000], ["2026-07-05", 100_000], ["2026-08-05", 100_000], ["2026-09-05", 240_000]] as const) {
      await tx(almost.user.id, almost.account.id, { date, amount, description: "TO FAIRMONEY - TUNDE NWOSU", merchant: "FairMoney" });
    }
    expect(await inferMissingLoans(almost.user.id, later)).toBe(1);
    const still = await db.loan.findFirstOrThrow({ where: { userId: almost.user.id } });
    expect(still.status).toBe("open");
    expect((await buildQuestions(almost.user.id, undefined, later)).some((q) => q.title === "Is your FairMoney loan paid off?")).toBe(true);
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
