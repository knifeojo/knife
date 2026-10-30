import { describe, expect, it, onTestFinished, vi } from "vitest";
import { db } from "@/lib/db";
import { issueSession } from "@/lib/auth";
import { importStatement } from "@/core/statement-import";
import {
  BUFFER_FLOOR_MINOR, assessAffordability, loadAffordabilityData, parseAmountInput, parseHorizon,
  type AffordabilityData, type AffordabilityResult, type CategorySpend, type LenderActivity, type MonthFigures, type RegularItem, type SpendItem,
} from "@/core/affordability";
import { POST as afford } from "@/app/api/v1/affordability/route";

// Synthetic figures only. ₦ amounts are converted to kobo with BigInt.
const N = (naira: number) => BigInt(naira) * 100n;
const NOW = new Date("2026-10-15T09:00:00Z"); // 10:00 in Lagos; the month ends 31 Oct 23:00 UTC

/** The API routes read the clock and these fixtures have fixed dates, so tests that call them pin it. Only Date is faked. */
function pinClock(now: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

const MONTH_END = { kind: "month_end" } as const;

const month = (label: string, income: number, spending: number, loans = 0, categories: CategorySpend[] = []): MonthFigures => ({
  label, incomeMinor: N(income), spendingMinor: N(spending), loanRepaymentsMinor: N(loans), categories, partial: false, days: 30,
});
const regular = (name: string, category: string, naira: number, last: string, next: string): RegularItem => ({
  name, category, amountMinor: N(naira), lastDate: new Date(last), nextExpected: new Date(next),
});
const data = (over: Partial<AffordabilityData> = {}): AffordabilityData => ({
  cash: { minor: N(2_000_000), asOf: NOW, accounts: 1 },
  otherCurrencies: [],
  months: [month("September 2026", 1_200_000, 700_000, 50_000), month("August 2026", 1_000_000, 650_000, 50_000), month("July 2026", 1_500_000, 900_000, 50_000)],
  obligations: [
    regular("Rent", "Housing", 250_000, "2026-09-25T09:00:00Z", "2026-10-25T09:00:00Z"),
    regular("FairMoney", "Debt", 50_000, "2026-10-05T09:00:00Z", "2026-11-04T09:00:00Z"),
    regular("Grace Doe", "Family", 100_000, "2026-10-01T09:00:00Z", "2026-10-31T09:00:00Z"),
    regular("Shoprite", "Food", 80_000, "2026-10-10T09:00:00Z", "2026-11-09T09:00:00Z"),
  ],
  income: [regular("Acme Technologies", "Income", 1_200_000, "2026-09-24T09:00:00Z", "2026-10-24T09:00:00Z")],
  lenders: [],
  oneOffs: [],
  oneOffsSince: new Date("2026-06-30T23:00:00Z"),
  ...over,
});
const noEmDash = (r: { headline: string; detail: string[]; notes: string[] }) =>
  expect([r.headline, ...r.detail, ...r.notes].join(" ")).not.toMatch(/[\u2014\u2013]/);

describe("affordability: the formula", () => {
  it("says yes and shows the inputs it used", () => {
    const r = assessAffordability(data(), { amountMinor: N(500_000), description: "a phone", horizon: MONTH_END }, NOW);
    expect(r.verdict).toBe("yes");
    expect(r.inputs).toMatchObject({
      cashMinor: N(2_000_000), cashKnown: true,
      monthlyIncomeMinor: N(1_200_000), // middle of 1.0M, 1.2M, 1.5M
      monthlyObligationsMinor: N(400_000), // rent + FairMoney + family; Shoprite is everyday spending
      otherLoanRepaymentsMinor: 0n,
      monthlyEverydayMinor: N(300_000), // 700K typical spending minus 400K obligations
      monthlySurplusMinor: N(500_000),
      bufferMinor: N(400_000), bufferRule: "obligations",
    });
    expect(r.inputs.obligations.map((o) => o.name).sort()).toEqual(["FairMoney", "Grace Doe", "Rent"]);
    expect(r.inputs.incomeMonths).toEqual(["September 2026", "August 2026", "July 2026"]);
    // Rent (25 Oct) and family (31 Oct) fall before month end; FairMoney (4 Nov) does not.
    expect(r.projection).toMatchObject({ incomeInMinor: N(1_200_000), incomeRule: "paydays", obligationsOutMinor: N(350_000), everydayOutMinor: N(170_000) });
    // Lowest just before payday on 24 Oct: 2M - 500K - 9 days of everyday spending (90K).
    expect(r.projection.lowestMinor).toBe(N(1_410_000));
    expect(r.projection.headroomMinor).toBe(N(1_010_000));
    expect(r.headline).toMatch(/^Yes\. After paying ₦500,000\.00 for a phone/);
    expect(typeof r.projection.lowestMinor).toBe("bigint");
    noEmDash(r);
  });

  it("no income: answers from cash alone and says there is no surplus to save from", () => {
    const thin = data({
      cash: { minor: N(300_000), asOf: NOW, accounts: 1 },
      months: [month("September 2026", 0, 200_000), month("August 2026", 0, 200_000), month("July 2026", 0, 200_000)],
      obligations: [], income: [],
    });
    const r = assessAffordability(thin, { amountMinor: N(150_000), horizon: MONTH_END }, NOW);
    expect(r.inputs.monthlyIncomeMinor).toBe(0n);
    expect(r.projection).toMatchObject({ incomeInMinor: 0n, incomeRule: "none" });
    // 300K - 150K - 17 days of 200K a month (113,333.34, rounded up to the kobo)
    expect(r.projection.lowestMinor).toBe(N(300_000) - N(150_000) - 11_333_334n);
    expect(r.verdict).toBe("stretch");
    expect(r.monthsToSave).toBeNull();
    expect(r.notes).toContain("No income found in your recent months.");
    expect(r.detail.join(" ")).toMatch(/no surplus/);

    const broke = assessAffordability({ ...thin, cash: null }, { amountMinor: N(10_000), horizon: MONTH_END }, NOW);
    expect(broke.verdict).toBe("no");
    expect(broke.inputs.cashKnown).toBe(false);
    expect(broke.notes[0]).toMatch(/No account balance on file, so Ledger starts from ₦0/);
    noEmDash(broke);
  });

  it("obligations above income: negative surplus, and a small purchase is still a no", () => {
    const tight = data({
      cash: { minor: N(100_000), asOf: NOW, accounts: 1 },
      months: [month("September 2026", 300_000, 450_000, 150_000), month("August 2026", 300_000, 450_000, 150_000), month("July 2026", 300_000, 450_000, 150_000)],
      obligations: [
        regular("Rent", "Housing", 250_000, "2026-09-20T09:00:00Z", "2026-10-20T09:00:00Z"),
        regular("Renmoney", "Debt", 150_000, "2026-09-28T09:00:00Z", "2026-10-28T09:00:00Z"),
      ],
      income: [],
    });
    const r = assessAffordability(tight, { amountMinor: N(20_000), horizon: { kind: "days", days: 30 } }, NOW);
    expect(r.inputs.monthlyObligationsMinor).toBe(N(400_000));
    expect(r.inputs.monthlySurplusMinor).toBe(N(-150_000));
    // No payday found and no full 30 days ahead, so no income is counted in.
    expect(r.projection.incomeInMinor).toBe(0n);
    expect(r.projection.lowestMinor).toBe(N(100_000 - 20_000 - 400_000 - 50_000));
    expect(r.verdict).toBe("no");
    expect(r.monthsToSave).toBeNull();
    expect(r.notes).toContain("Your usual outgoings are more than your usual income.");
    expect(r.headline).toMatch(/^Not right now\. Paying ₦20,000\.00 would leave you ₦370,000\.00 short/);
  });

  it("large one-off: no when it exceeds cash, stretch when it only eats the buffer, with time to save", () => {
    const big = data({ cash: { minor: N(5_000_000), asOf: NOW, accounts: 1 } });
    const car = assessAffordability(big, { amountMinor: N(8_000_000), description: "a car", horizon: MONTH_END }, NOW);
    expect(car.verdict).toBe("no");
    expect(car.notes).toContain("This costs more than a month of your income.");
    const gap = car.inputs.bufferMinor - car.projection.lowestMinor;
    expect(car.monthsToSave).toBe(Number((gap + N(500_000) - 1n) / N(500_000)));
    expect(car.detail.join(" ")).toMatch(/usual surplus of ₦500,000\.00 a month, about \d+ months of saving/);

    // 5M - 4.6M - 90K everyday before payday = 310K: still positive, but under the 400K buffer.
    const deposit = assessAffordability(big, { amountMinor: N(4_600_000), horizon: MONTH_END }, NOW);
    expect(deposit.verdict).toBe("stretch");
    expect(deposit.projection.lowestMinor).toBe(N(310_000));
    expect(deposit.monthsToSave).toBe(1);
    expect(deposit.headline).toMatch(/^It's a stretch\./);
    noEmDash(deposit);
  });

  it("buffer floor: never below ₦50,000, defaults to a month of obligations, and the user's own buffer above the floor wins", () => {
    const small = data({
      months: [month("September 2026", 400_000, 200_000)],
      obligations: [regular("Netflix", "Subscriptions", 4_400, "2026-10-01T09:00:00Z", "2026-10-31T09:00:00Z")],
    });
    const floor = assessAffordability(small, { amountMinor: N(1_000), horizon: MONTH_END }, NOW);
    expect(floor.inputs).toMatchObject({ bufferMinor: BUFFER_FLOOR_MINOR, bufferRule: "floor" });
    const zero = assessAffordability(small, { amountMinor: N(1_000), horizon: MONTH_END, bufferMinor: 0n }, NOW);
    expect(zero.inputs).toMatchObject({ bufferMinor: BUFFER_FLOOR_MINOR, bufferRule: "floor" });
    const mine = assessAffordability(small, { amountMinor: N(1_000), horizon: MONTH_END, bufferMinor: N(1_500_000) }, NOW);
    expect(mine.inputs).toMatchObject({ bufferMinor: N(1_500_000), bufferRule: "yours" });
    expect(assessAffordability(data(), { amountMinor: N(1_000), horizon: MONTH_END }, NOW).inputs.bufferRule).toBe("obligations");
  });

  it("counts a recently missed obligation once, drops one long finished, and never assumes a late payday", () => {
    const r = assessAffordability(data({
      obligations: [
        regular("Rent", "Housing", 250_000, "2026-09-01T09:00:00Z", "2026-10-01T09:00:00Z"), // 14 days overdue
        regular("Old loan", "Debt", 90_000, "2026-07-01T09:00:00Z", "2026-08-01T09:00:00Z"), // 75 days overdue
      ],
      income: [regular("Acme Technologies", "Income", 1_200_000, "2026-09-01T09:00:00Z", "2026-10-01T09:00:00Z")], // 14 days late
    }), { amountMinor: N(100_000), horizon: MONTH_END }, NOW);
    expect(r.inputs.obligations).toHaveLength(1);
    expect(r.inputs.obligations[0]).toMatchObject({ name: "Rent", dueInWindowMinor: N(250_000) });
    expect(r.inputs.obligations[0].nextDue).toEqual(NOW);
    expect(r.projection.incomeInMinor).toBe(0n);
  });

  it("spreads loan repayments that have no monthly pattern, such as weekly app repayments", () => {
    const r = assessAffordability(data({ obligations: [], months: [month("September 2026", 1_000_000, 600_000, 120_000)] }), { amountMinor: N(1_000), horizon: { kind: "days", days: 30 } }, NOW);
    expect(r.inputs.otherLoanRepaymentsMinor).toBe(N(120_000));
    expect(r.inputs.monthlyObligationsMinor).toBe(N(120_000));
    expect(r.inputs.bufferMinor).toBe(N(120_000));
    expect(r.notes.join(" ")).toMatch(/₦120,000\.00 a month of loan repayments does not follow a monthly pattern/);
    expect(r.notes.join(" ")).toMatch(/Based on 1 full month/);
  });

  it("thin data: with only the month in progress, income is not counted and spending is scaled to 30 days", () => {
    const r = assessAffordability(data({
      months: [{ label: "October 2026", incomeMinor: N(900_000), spendingMinor: N(140_000), loanRepaymentsMinor: 0n, categories: [], partial: true, days: 14 }],
      obligations: [], income: [],
    }), { amountMinor: N(10_000), horizon: MONTH_END }, NOW);
    expect(r.inputs.monthlyIncomeMinor).toBe(0n);
    expect(r.inputs.monthlyEverydayMinor).toBe(N(300_000));
    expect(r.inputs.incomeMonths).toEqual(["October 2026 so far"]);
    expect(r.notes).toContain("Less than one full month of history, so income is not counted yet.");
  });

  it("starts from an old balance date and estimates the days since", () => {
    const asOf = new Date("2026-10-01T09:00:00Z");
    const r = assessAffordability(data({ cash: { minor: N(2_000_000), asOf, accounts: 1 } }), { amountMinor: N(1_000), horizon: MONTH_END }, NOW);
    expect(r.window).toMatchObject({ startsAtBalanceDate: true });
    expect(new Date(r.window.from)).toEqual(asOf);
    expect(r.notes.join(" ")).toMatch(/Your balance is from 1 Oct\. Spending since then is estimated/);
    expect(r.projection.everydayOutMinor).toBeGreaterThan(N(300_000)); // 31 days of everyday spending, not 17
  });
});

const dated = ([date, naira]: [string, number]) => ({ date: new Date(date), amountMinor: N(naira) });
const lender = (name: string, repayments: [string, number][], proceeds: [string, number][] = []): LenderActivity => ({
  name, repayments: repayments.map(dated), proceeds: proceeds.map(dated),
});
const spend = (name: string, category: string, label: string | undefined, naira: number, date: string): SpendItem => ({
  name, category, label, amountMinor: N(naira), date: new Date(date),
});
const cat = (category: string, subcategory: string | null, naira: number): CategorySpend => ({ category, subcategory, totalMinor: N(naira) });
const everything = (r: AffordabilityResult) => [r.headline, ...r.detail, ...r.notes, ...r.advice.map((a) => a.text)].join(" ");
const nairaIn = (text: string) => [...text.matchAll(/₦[\d,]+(?:\.\d\d)?/g)].map((m) => m[0]);
const CAR = { amountMinor: N(1_800_000), description: "a car deposit", horizon: MONTH_END } as const;

describe("affordability: what would help", () => {
  it("names the loan to clear first and the least that is still open, from what the ledger shows", () => {
    const r = assessAffordability(data({
      lenders: [
        lender("Renmoney", [["2026-08-05T09:00:00Z", 100_000], ["2026-09-05T09:00:00Z", 100_000]], [["2026-06-03T09:00:00Z", 1_500_000]]),
        lender("Carbon", [["2026-05-05T09:00:00Z", 40_000], ["2026-06-05T09:00:00Z", 40_000]]), // last paid in June: finished
      ],
    }), CAR, NOW);
    expect(r.verdict).toBe("stretch");
    expect(r.advice[0]).toEqual({
      kind: "debt", subject: "Renmoney", monthlyMinor: N(100_000), openMinor: N(1_300_000),
      text: "Clear Renmoney first: at least ₦1,300,000 is still open (₦1,500,000 borrowed on 3 Jun, ₦200,000 repaid since, interest not counted). At ₦100,000 a month that takes at least 13 more months, then that money is free.",
    });
    expect(r.advice.filter((a) => a.kind === "debt")).toHaveLength(1);
    expect(everything(r)).not.toMatch(/Carbon/);
    expect(typeof r.advice[0].openMinor).toBe("bigint");
    expect(everything(r)).not.toMatch(/[\u2014\u2013]/);
  });

  it("never invents a balance: says so when Ledger cannot tell what is left on a loan", () => {
    const r = assessAffordability(data({
      lenders: [
        lender("FairMoney", [["2026-08-05T09:00:00Z", 50_000], ["2026-09-05T09:00:00Z", 50_000], ["2026-10-05T09:00:00Z", 50_000]]),
        // Weekly-ish repayments that add up to ₦60,000 a month, and more repaid than Ledger saw borrowed.
        lender("PalmCredit", [["2026-08-15T09:00:00Z", 30_000], ["2026-08-29T09:00:00Z", 30_000], ["2026-09-15T09:00:00Z", 60_000]], [["2026-08-01T09:00:00Z", 100_000]]),
      ],
    }), CAR, NOW);
    const [palm, fair] = r.advice.filter((a) => a.kind === "debt");
    expect(palm).toMatchObject({ subject: "PalmCredit", monthlyMinor: N(60_000), openMinor: null });
    expect(palm.text).toBe("Clear PalmCredit first. You repay about ₦60,000 a month. You have repaid more than the ₦100,000 Ledger saw you borrow, so check with PalmCredit for what is left. Once it is done, that ₦60,000 a month is free.");
    expect(fair).toMatchObject({ subject: "FairMoney", monthlyMinor: N(50_000), openMinor: null });
    expect(fair.text).toBe("Clear FairMoney first. You repay about ₦50,000 a month. Ledger has not seen this loan paid out, so it cannot tell how much is left. Check with FairMoney. Once it is done, that ₦50,000 a month is free.");
    for (const line of [palm, fair]) expect(line.text).not.toMatch(/still open|left: ₦/);
    // Every figure quoted comes straight from the lender's own rows.
    expect(nairaIn(palm.text)).toEqual(["₦60,000", "₦100,000", "₦60,000"]);
    expect(nairaIn(fair.text)).toEqual(["₦50,000", "₦50,000"]);
  });

  it("a loan just paid out with no repayment yet: the whole amount is open, and no monthly figure is made up", () => {
    const r = assessAffordability(data({ lenders: [lender("Renmoney", [], [["2026-10-02T09:00:00Z", 500_000]])] }), CAR, NOW);
    expect(r.advice[0]).toEqual({
      kind: "debt", subject: "Renmoney", monthlyMinor: null, openMinor: N(500_000),
      text: "Clear Renmoney first: at least ₦500,000 is still open (₦500,000 borrowed on 2 Oct, nothing repaid yet, interest not counted).",
    });
  });

  it("suggests cutting a high discretionary category, sized by the same day-by-day projection", () => {
    const cats = [cat("Shopping", "Clothing", 150_000), cat("Food", "Eating out", 60_000), cat("Healthcare", null, 100_000), cat("Family", "Family support", 100_000)];
    const months = [
      month("September 2026", 1_200_000, 700_000, 50_000, cats),
      month("August 2026", 1_000_000, 650_000, 50_000, cats),
      month("July 2026", 1_500_000, 900_000, 50_000, cats),
    ];
    const req = { amountMinor: N(1_525_000), horizon: MONTH_END } as const;
    const r = assessAffordability(data({ months }), req, NOW);
    expect(r.verdict).toBe("stretch");
    expect(r.projection.headroomMinor).toBe(N(-15_000));
    const cuts = r.advice.filter((a) => a.kind === "cut");
    // Health and family are never suggested for cutting.
    expect(r.advice.map((a) => a.subject)).toEqual(["Shopping", "Food"]);
    expect(cuts[0]).toMatchObject({ monthlyMinor: N(50_000), openMinor: null });
    expect(cuts[0].text).toBe("Spend about ₦50,000 a month less on Shopping (mostly clothing) from today and you stay above your buffer to 31 Oct. You spent about ₦150,000 a month there from July to September.");
    // Check the figure against the formula itself: ₦50,000 a month less everyday spending is a yes, ₦49,000 is not.
    const withLess = (naira: number) => assessAffordability(data({ months: months.map((m) => ({ ...m, spendingMinor: m.spendingMinor - N(naira) })) }), req, NOW).verdict;
    expect(withLess(50_000)).toBe("yes");
    expect(withLess(49_000)).toBe("stretch");
    // Half of Food is not enough before payday. The usual surplus already covers the gap in a month, so no faster date is promised.
    expect(cuts[1]).toMatchObject({ monthlyMinor: N(30_000) });
    expect(cuts[1].text).toBe("Cut Food (mostly eating out) by about ₦30,000 a month. You spent about ₦60,000 a month there from July to September. That is ₦30,000 more each month toward the ₦15,000 gap.");
  });

  it("when there is no surplus, a cut says how much sooner it gets there, or that it is not enough alone", () => {
    const shopping = [cat("Shopping", null, 200_000)];
    const tight = (income: number) => data({
      cash: { minor: N(500_000), asOf: NOW, accounts: 1 },
      months: [month("September 2026", income, 700_000, 0, shopping), month("August 2026", income, 700_000, 0, shopping), month("July 2026", income, 700_000, 0, shopping)],
    });
    const some = assessAffordability(tight(750_000), CAR, NOW); // ₦50,000 surplus
    expect(some.monthsToSave).toBe(36);
    expect(some.advice.find((a) => a.kind === "cut")!.text).toMatch(/Cut Shopping by about ₦100,000 a month\. You spent about ₦200,000 a month there from July to September\. With your usual surplus, that saves the ₦1,790,000 gap in about 12 months instead of 36\.$/);
    const turned = assessAffordability(tight(650_000), CAR, NOW); // ₦50,000 short every month, ₦50,000 over once cut
    expect(turned.monthsToSave).toBeNull();
    expect(turned.advice.find((a) => a.kind === "cut")!.text).toMatch(/That leaves you a surplus each month, enough to save the ₦[\d,]+ gap in about \d+ months\.$/);
    const none = assessAffordability(tight(550_000), CAR, NOW); // ₦150,000 short every month
    expect(none.advice.find((a) => a.kind === "cut")!.text).toMatch(/Your outgoings would still be above your income, so this alone is not enough\.$/);
  });

  it("separates recurring bills from one-offs, and does not mistake a one-off for a habit", () => {
    const r = assessAffordability(data({
      months: [
        month("September 2026", 1_200_000, 700_000, 50_000, [cat("Shopping", "Clothing", 15_000)]),
        month("August 2026", 1_000_000, 1_100_000, 50_000, [cat("Shopping", "Electronics", 450_000), cat("Shopping", "Clothing", 15_000)]),
        month("July 2026", 1_500_000, 900_000, 50_000, [cat("Shopping", "Clothing", 15_000)]),
      ],
      oneOffs: [
        spend("Fouani Showroom", "Shopping", "Electronics", 450_000, "2026-08-12T10:00:00Z"),
        spend("Oluwaseun Adeyemi", "Housing", "Rent", 1_200_000, "2026-08-01T10:00:00Z"), // a year's rent: a bill, seen once
        spend("Konga", "Shopping", undefined, 100_000, "2026-10-03T10:00:00Z"), // under a tenth of income
      ],
    }), CAR, NOW);
    expect(r.inputs.obligations.map((o) => o.kind)).toEqual(["recurring", "recurring", "recurring"]);
    expect(r.inputs.oneOffMinMinor).toBe(N(120_000));
    expect(r.inputs.oneOffs.map((o) => [o.name, o.kind, o.amountMinor])).toEqual([["Oluwaseun Adeyemi", "one_off", N(1_200_000)], ["Fouani Showroom", "one_off", N(450_000)]]);
    expect(r.inputs.oneOffsTotalMinor).toBe(N(1_650_000));
    const line = r.advice.find((a) => a.kind === "one_off")!;
    expect(line).toMatchObject({ subject: "Fouani Showroom", monthlyMinor: null, openMinor: null });
    expect(line.text).toBe("A one-off spend took ₦450,000 on 12 Aug (Fouani Showroom). It is not a bill, so holding off on more like it until you have bought this keeps that cash free.");
    // Without the one-off, Shopping is ₦15,000 a month: not worth naming.
    expect(r.advice.some((a) => a.kind === "cut")).toBe(false);
  });

  it("orders the advice loans first, then spending, then one-offs, and stops at five lines", () => {
    const cats = [cat("Shopping", null, 150_000), cat("Food", null, 90_000), cat("Transport", "Car", 80_000)];
    const r = assessAffordability(data({
      months: [month("September 2026", 1_200_000, 700_000, 0, cats), month("August 2026", 1_000_000, 650_000, 0, cats), month("July 2026", 1_500_000, 900_000, 0, cats)],
      lenders: [
        lender("FairMoney", [["2026-09-05T09:00:00Z", 50_000]]),
        lender("Renmoney", [["2026-09-05T09:00:00Z", 100_000]]),
        lender("Carbon", [["2026-09-05T09:00:00Z", 20_000]]),
      ],
      oneOffs: [spend("Fouani Showroom", "Shopping", "Electronics", 450_000, "2026-08-12T10:00:00Z"), spend("Air Peace", "Travel", undefined, 300_000, "2026-08-20T10:00:00Z")],
    }), CAR, NOW);
    expect(r.advice.map((a) => [a.kind, a.subject])).toEqual([
      ["debt", "Renmoney"], ["debt", "FairMoney"], ["cut", "Shopping"], ["cut", "Food"], ["one_off", "Fouani Showroom"],
    ]);
    expect(r.advice[4].text).toBe("One-off spends took ₦750,000 since 1 Jul (2 payments, the biggest ₦450,000 to Fouani Showroom on 12 Aug). They are not bills, so holding off on more like them until you have bought this keeps that cash free.");
    expect(everything(r)).not.toMatch(/[\u2014\u2013]/);
  });

  it("a yes gets at most one tip, about a loan still being repaid", () => {
    const yes = assessAffordability(data({ lenders: [lender("FairMoney", [["2026-09-05T09:00:00Z", 50_000], ["2026-10-05T09:00:00Z", 50_000]])] }), { amountMinor: N(100_000), horizon: MONTH_END }, NOW);
    expect(yes.verdict).toBe("yes");
    expect(yes.advice).toEqual([{
      kind: "debt", subject: "FairMoney", monthlyMinor: N(50_000), openMinor: null,
      text: "You still repay FairMoney about ₦50,000 a month. Clearing it first leaves more room for what comes next.",
    }]);
    expect(assessAffordability(data(), { amountMinor: N(100_000), horizon: MONTH_END }, NOW).advice).toEqual([]);
  });

  it("says plainly when nothing in the ledger stands out", () => {
    const r = assessAffordability(data(), CAR, NOW);
    expect(r.advice).toEqual([{ kind: "none", subject: null, monthlyMinor: null, openMinor: null, text: "Ledger found no loans, big spending categories or one-off spends to point to from July to September." }]);
  });
});

describe("affordability: input parsing", () => {
  it("reads amounts people type, in kobo, without floats", () => {
    expect(parseAmountInput("2.5m")).toBe(250_000_000n);
    expect(parseAmountInput("500k")).toBe(50_000_000n);
    expect(parseAmountInput("₦1,200,000.50")).toBe(120_000_050n);
    expect(parseAmountInput("N 750,000")).toBe(75_000_000n);
    for (const bad of ["", "0", "-5", "abc", "1e9", "1.234", "999999999999m"]) expect(parseAmountInput(bad)).toBeNull();
  });

  it("accepts month end or 1 to 120 days", () => {
    expect(parseHorizon(undefined)).toEqual({ kind: "month_end" });
    expect(parseHorizon("30")).toEqual({ kind: "days", days: 30 });
    expect(parseHorizon(90)).toEqual({ kind: "days", days: 90 });
    for (const bad of [0, 121, "soon", 2.5]) expect(parseHorizon(bad)).toBeNull();
  });
});

type Row = [day: number, debit: number, credit: number, remarks: string];
const statement = (extra: (month: string) => Row[] = () => []) => {
  const rows: string[] = [];
  let bal = 500_000;
  const fmt = (n: number) => `"${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}"`;
  for (const m of ["Jul", "Aug", "Sep"]) {
    const month: Row[] = [
      [1, 100_000, 0, "TRF MUM UPKEEP TO GRACE DOE"],
      [5, 50_000, 0, "Instant Payment Outward TO FAIRMONEY MFB - JANE ADA DOE"],
      [15, 80_000, 0, "POS SHOPRITE LEKKI"],
      [24, 0, 1_000_000, "NIP ACME TECHNOLOGIES SALARY"],
      [25, 250_000, 0, "TRF RENT OLUWASEUN ADEYEMI"],
      ...extra(m),
    ];
    for (const [day, debit, credit, remarks] of month.sort((a, b) => a[0] - b[0])) {
      const date = `${String(day).padStart(2, "0")}-${m}-2026`;
      bal += credit - debit;
      rows.push(`${date},,${date},${debit ? fmt(debit) : ""},${credit ? fmt(credit) : ""},${fmt(bal)},${remarks}`);
    }
  }
  return [
    "Guaranty Trust Bank Plc,,,,,,",
    "Customer Statement (SYNTHETIC TEST DATA),,,,,,",
    "Account Name,JANE ADA DOE,,,,,",
    "Account No,0123459999,,,,,",
    "Period,01-Jul-2026 to 25-Sep-2026,,,,,",
    ",,,,,,",
    "Trans. Date,Reference,Value Date,Debits,Credits,Balance,Remarks",
    "01-Jul-2026,,01-Jul-2026,,,\"500,000.00\",Opening Balance",
    ...rows,
  ].join("\n");
};
const STATEMENT = statement();

describe("affordability: from an imported statement", () => {
  it("finds income, rent, family support and a FairMoney repayment in the user's own name", async () => {
    const user = await db.user.create({ data: { email: "afford-ledger@test.dev" } });
    await importStatement(user.id, { name: "synthetic.csv", bytes: Buffer.from(STATEMENT) });
    const now = new Date("2026-10-10T09:00:00Z");
    const d = await loadAffordabilityData(user.id, now);
    expect(d.cash?.minor).toBe(N(2_060_000));
    expect(d.months.map((m) => m.label)).toEqual(["September 2026", "August 2026", "July 2026"]);
    expect(d.months.every((m) => m.incomeMinor === N(1_000_000) && m.spendingMinor === N(480_000) && m.loanRepaymentsMinor === N(50_000))).toBe(true);

    const r = assessAffordability(d, { amountMinor: N(300_000), horizon: MONTH_END }, now);
    const byCategory = Object.fromEntries(r.inputs.obligations.map((o) => [o.category, o.monthlyMinor]));
    expect(byCategory).toEqual({ Debt: N(50_000), Family: N(100_000), Housing: N(250_000) });
    expect(r.inputs).toMatchObject({ monthlyIncomeMinor: N(1_000_000), monthlyObligationsMinor: N(400_000), otherLoanRepaymentsMinor: 0n, monthlyEverydayMinor: N(80_000) });
    expect(r.projection.incomeRule).toBe("paydays");
    expect(r.verdict).toBe("yes");
    expect(assessAffordability(d, { amountMinor: N(1_700_000), horizon: MONTH_END }, now).verdict).toBe("stretch");
    expect(assessAffordability(d, { amountMinor: N(2_500_000), horizon: MONTH_END }, now).verdict).toBe("no");
  });

  it("turns a no into named next steps: the Renmoney loan, eating out, and a one-off purchase", async () => {
    const user = await db.user.create({ data: { email: "afford-advice@test.dev" } });
    const csv = statement((m) => [
      ...(m === "Jul" ? [[3, 0, 600_000, "NIP FROM RENMONEY MFB LOAN DISBURSEMENT"] as Row] : []),
      [10, 100_000, 0, "Instant Payment Outward TO RENMONEY MFB - JANE ADA DOE"],
      [18, 60_000, 0, "POS CHICKEN REPUBLIC LEKKI"],
      ...(m === "Aug" ? [[12, 450_000, 0, "TRF TO ZBN - FOUANI SHOWROOM"] as Row] : []),
    ]);
    await importStatement(user.id, { name: "synthetic.csv", bytes: Buffer.from(csv) });
    const now = new Date("2026-10-10T09:00:00Z");
    const d = await loadAffordabilityData(user.id, now);
    expect(d.lenders.map((l) => [l.name, l.repayments.length, l.proceeds.length]).sort()).toEqual([["FairMoney", 3, 0], ["Renmoney", 3, 1]]);
    // Chicken Republic is a monthly habit, so it is not a one-off; Fouani is.
    expect(d.oneOffs.map((o) => o.name)).toEqual(["Fouani Showroom"]);

    const r = assessAffordability(d, { amountMinor: N(2_500_000), description: "a used car", horizon: MONTH_END }, now);
    expect(r.verdict).toBe("no");
    expect(r.inputs.obligations.map((o) => [o.name, o.kind]).sort()).toEqual([["FairMoney", "recurring"], ["Grace Doe", "recurring"], ["Renmoney", "recurring"], ["TRF RENT OLUWASEUN ADEYEMI", "recurring"]]);
    expect(r.inputs.oneOffs).toMatchObject([{ name: "Fouani Showroom", category: "Shopping", label: "Electronics", amountMinor: N(450_000), kind: "one_off" }]);
    expect(r.advice.map((a) => [a.kind, a.subject])).toEqual([["debt", "Renmoney"], ["debt", "FairMoney"], ["cut", "Food"], ["one_off", "Fouani Showroom"]]);
    expect(r.advice[0].text).toBe("Clear Renmoney: about ₦100,000 a month. Ledger has not seen the balance, so this is only the usual repayment.");
    expect(r.advice[1].text).toBe("Clear FairMoney: about ₦50,000 a month. Ledger has not seen the balance, so this is only the usual repayment.");
    expect(r.advice[0].openMinor).toBeNull();
    expect(r.advice[0].text).not.toMatch(/left/);
    expect(r.advice[2].text).toMatch(/^Cut Food \(mostly groceries\) by about ₦70,000 a month\. You spent about ₦140,000 a month there from July to September\./);
  });
});

describe("POST /api/v1/affordability", () => {
  const post = (token: string | null, body: unknown) => afford(new Request("http://localhost/api/v1/affordability", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));

  it("needs a session, valid kobo strings, and some imported data", async () => {
    expect((await post(null, { amountMinor: "100" })).status).toBe(401);
    const user = await db.user.create({ data: { email: "afford-api@test.dev" } });
    const { token } = await issueSession(user.id);
    expect((await post(token, { amountMinor: 2500 })).status).toBe(400);
    expect((await post(token, { amountMinor: "2.5" })).status).toBe(400);
    expect((await post(token, { amountMinor: "0" })).status).toBe(400);
    expect((await post(token, { amountMinor: "100", horizon: 365 })).status).toBe(400);
    expect((await post(token, { amountMinor: "100", bufferMinor: 5 })).status).toBe(400);
    const empty = await post(token, { amountMinor: "100" });
    expect(empty.status).toBe(409);
    expect(await empty.json()).toEqual({ error: "Import a statement first so Ledger has your income and spending to go on." });
  });

  it("returns a verdict with every amount as a minor-unit string", async () => {
    pinClock(NOW);
    const user = await db.user.create({ data: { email: "afford-api-data@test.dev" } });
    await importStatement(user.id, { name: "synthetic.csv", bytes: Buffer.from(STATEMENT) });
    const { token } = await issueSession(user.id);
    const res = await post(token, { amountMinor: "10000000", description: "A fridge \u2014 new", horizon: 30, bufferMinor: "20000000" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(["yes", "stretch", "no"]).toContain(body.verdict);
    expect(body.amountMinor).toBe("10000000");
    expect(body.description).toBe("A fridge new");
    expect(body.inputs.cashMinor).toBe("206000000");
    expect(body.inputs.bufferMinor).toBe("20000000");
    expect(body.inputs.bufferRule).toBe("yours");
    expect(typeof body.projection.lowestMinor).toBe("string");
    expect(body.projection.lowestMinor).toMatch(/^-?\d+$/);
    expect(body.window.to).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.inputs.obligations.every((o: { kind: string }) => o.kind === "recurring")).toBe(true);
    expect(body.inputs.oneOffs).toEqual([]);
    expect(body.inputs.oneOffsTotalMinor).toBe("0");
    expect(body.inputs.oneOffMinMinor).toBe("10000000");
    expect(body.inputs.oneOffsSince).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Array.isArray(body.advice)).toBe(true);

    const no = await (await post(token, { amountMinor: "300000000", horizon: "month_end" })).json();
    expect(no.verdict).toBe("no");
    expect(no.advice[0]).toMatchObject({ kind: "debt", subject: "FairMoney", monthlyMinor: "5000000", openMinor: null });
    expect(no.advice[0].text).toBe("Clear FairMoney: about ₦50,000 a month. Ledger has not seen the balance, so this is only the usual repayment.");
    expect(JSON.stringify(body)).not.toMatch(/[\u2014\u2013]/);
    expect(JSON.stringify(no)).not.toMatch(/[\u2014\u2013]/);
  });
});
