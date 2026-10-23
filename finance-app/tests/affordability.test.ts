import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { issueSession } from "@/lib/auth";
import { importStatement } from "@/core/statement-import";
import {
  BUFFER_FLOOR_MINOR, assessAffordability, loadAffordabilityData, parseAmountInput, parseHorizon,
  type AffordabilityData, type MonthFigures, type RegularItem,
} from "@/core/affordability";
import { POST as afford } from "@/app/api/v1/affordability/route";

// Synthetic figures only. ₦ amounts are converted to kobo with BigInt.
const N = (naira: number) => BigInt(naira) * 100n;
const NOW = new Date("2026-10-15T09:00:00Z"); // 10:00 in Lagos; the month ends 31 Oct 23:00 UTC
const MONTH_END = { kind: "month_end" } as const;

const month = (label: string, income: number, spending: number, loans = 0): MonthFigures => ({
  label, incomeMinor: N(income), spendingMinor: N(spending), loanRepaymentsMinor: N(loans), partial: false, days: 30,
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
      months: [{ label: "October 2026", incomeMinor: N(900_000), spendingMinor: N(140_000), loanRepaymentsMinor: 0n, partial: true, days: 14 }],
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

const STATEMENT = (() => {
  const rows: string[] = [];
  let bal = 500_000;
  const fmt = (n: number) => `"${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}"`;
  const add = (date: string, debit: number, credit: number, remarks: string) => {
    bal += credit - debit;
    rows.push(`${date},,${date},${debit ? fmt(debit) : ""},${credit ? fmt(credit) : ""},${fmt(bal)},${remarks}`);
  };
  for (const m of ["Jul", "Aug", "Sep"]) {
    add(`01-${m}-2026`, 100_000, 0, "TRF MUM UPKEEP TO GRACE DOE");
    add(`05-${m}-2026`, 50_000, 0, "Instant Payment Outward TO FAIRMONEY MFB - JANE ADA DOE");
    add(`15-${m}-2026`, 80_000, 0, "POS SHOPRITE LEKKI");
    add(`24-${m}-2026`, 0, 1_000_000, "NIP ACME TECHNOLOGIES SALARY");
    add(`25-${m}-2026`, 250_000, 0, "TRF RENT OLUWASEUN ADEYEMI");
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
})();

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
    expect(JSON.stringify(body)).not.toMatch(/[\u2014\u2013]/);
  });
});
