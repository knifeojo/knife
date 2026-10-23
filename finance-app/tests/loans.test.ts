import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { issueSession } from "@/lib/auth";
import { importStatement } from "@/core/statement-import";
import { assessAffordability, loadAffordabilityData, type AffordabilityData, type LenderActivity, type MonthFigures, type RegularItem } from "@/core/affordability";
import { LENDER_NAMES, canonicalLender } from "@/core/categorize";
import { loanFieldsFromForm } from "@/core/loan-form";
import { addMonths, countRepayments, createLoan, listLoans, loanFieldsFromJson, payoffDate, type ManualLoan } from "@/core/loans";
import { GET as listRoute, POST as createRoute } from "@/app/api/v1/loans/route";
import { DELETE as deleteRoute, PATCH as patchRoute } from "@/app/api/v1/loans/[id]/route";
import { POST as afford } from "@/app/api/v1/affordability/route";

// Synthetic figures only.
const N = (naira: number) => BigInt(naira) * 100n;
const NOW = new Date("2026-10-15T09:00:00Z");
const D = (day: string) => new Date(`${day}T00:00:00Z`);
const MONTH_END = { kind: "month_end" } as const;
const NEXT_90 = { kind: "days", days: 90 } as const;
const CAR = { amountMinor: N(1_800_000), description: "a car deposit", horizon: MONTH_END } as const;

const month = (label: string, income: number, spending: number, loans = 0): MonthFigures => ({
  label, incomeMinor: N(income), spendingMinor: N(spending), loanRepaymentsMinor: N(loans), categories: [], partial: false, days: 30,
});
const regular = (name: string, category: string, naira: number, last: string, next: string): RegularItem => ({
  name, category, amountMinor: N(naira), lastDate: new Date(last), nextExpected: new Date(next),
});
const lender = (name: string, repayments: [string, number][], proceeds: [string, number][] = []): LenderActivity => ({
  name,
  repayments: repayments.map(([d, n]) => ({ date: new Date(d), amountMinor: N(n) })),
  proceeds: proceeds.map(([d, n]) => ({ date: new Date(d), amountMinor: N(n) })),
});
const RENMONEY_PAID = lender(
  "Renmoney",
  [["2026-07-28T09:00:00Z", 120_000], ["2026-08-28T09:00:00Z", 120_000], ["2026-09-28T09:00:00Z", 120_000]],
  [["2026-06-20T09:00:00Z", 600_000]],
);
const data = (over: Partial<AffordabilityData> = {}): AffordabilityData => ({
  cash: { minor: N(2_000_000), asOf: NOW, accounts: 1 },
  otherCurrencies: [],
  months: [month("September 2026", 1_200_000, 700_000, 120_000), month("August 2026", 1_200_000, 700_000, 120_000), month("July 2026", 1_200_000, 700_000, 120_000)],
  obligations: [
    regular("Rent", "Housing", 250_000, "2026-09-25T09:00:00Z", "2026-10-25T09:00:00Z"),
    regular("Renmoney", "Debt", 120_000, "2026-09-28T09:00:00Z", "2026-10-28T09:00:00Z"),
  ],
  income: [regular("Acme Technologies", "Income", 1_200_000, "2026-09-24T09:00:00Z", "2026-10-24T09:00:00Z")],
  lenders: [RENMONEY_PAID],
  oneOffs: [],
  oneOffsSince: new Date("2026-06-30T23:00:00Z"),
  ...over,
});
const loan = (over: Partial<ManualLoan> = {}): ManualLoan => ({
  id: "loan_1", lender: "Renmoney", outstandingMinor: N(360_000), instalmentMinor: N(120_000), instalmentsPaid: 3, instalmentsTotal: 6,
  nextDueDate: D("2026-10-28"), endDate: D("2026-12-28"), status: "open", balanceAsOf: new Date("2026-10-01T10:00:00Z"), closedAt: null,
  ...over,
});

describe("loans the user entered: lender names and dates", () => {
  it("files loans under the names lender detection gives statement rows", () => {
    expect(LENDER_NAMES).toEqual(expect.arrayContaining(["FairMoney", "Renmoney", "Carbon", "PalmCredit"]));
    expect(canonicalLender("renmoney")).toBe("Renmoney");
    expect(canonicalLender("RENMONEY MFB")).toBe("Renmoney");
    expect(canonicalLender("palm credit")).toBe("PalmCredit");
    expect(canonicalLender("OneFi")).toBe("Carbon");
    expect(canonicalLender("PalmPay")).toBeUndefined();
    expect(canonicalLender("GTBank")).toBeUndefined();
  });

  it("works out the last payment from the instalments left when no end date is given", () => {
    expect(payoffDate(loan({ endDate: null, nextDueDate: D("2026-10-31"), instalmentsPaid: 3, instalmentsTotal: 6 }))).toEqual(D("2026-12-31"));
    expect(payoffDate(loan({ endDate: null, instalmentsPaid: null }))).toBeNull();
    expect(addMonths(D("2027-01-31"), 1)).toEqual(D("2027-02-28"));
  });

  it("reads the web form and the JSON body, and refuses lenders Ledger does not detect", () => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ lender: "Renmoney", outstanding: "1.5m", instalment: "250,000", paid: "2", total: "8", nextDue: "2026-11-05", endDate: "", notes: " phone\u0007 loan " })) form.set(k, v);
    expect(loanFieldsFromForm(form)).toEqual({
      fields: { lender: "Renmoney", outstandingMinor: N(1_500_000), instalmentMinor: N(250_000), instalmentsPaid: 2, instalmentsTotal: 8, nextDueDate: D("2026-11-05"), endDate: null, notes: "phone loan" },
    });
    form.set("lender", "Kuda");
    expect(loanFieldsFromForm(form)).toMatchObject({ error: expect.stringMatching(/^Pick a lender Ledger knows/) });
    expect(loanFieldsFromJson({ lender: "Renmoney", outstandingMinor: 150000 })).toEqual({ error: "outstandingMinor must be a whole number of kobo, sent as a string" });
    expect(loanFieldsFromJson({ lender: "Renmoney", outstandingMinor: "100", instalmentsPaid: 9, instalmentsTotal: 6 })).toEqual({ error: "Instalments paid cannot be more than the total." });
    expect(loanFieldsFromJson({ lender: "Renmoney", outstandingMinor: "100", nextDueDate: "2026-12-01", endDate: "2026-11-01" })).toEqual({ error: "The last payment cannot be before the next one." });
    expect(loanFieldsFromJson({ lender: "Renmoney", outstandingMinor: "100", endDate: "2026-02-30" })).toEqual({ error: "nextDueDate and endDate must be YYYY-MM-DD" });
  });
});

describe("affordability with a loan the user entered", () => {
  it("uses the real balance and last payment instead of borrowed minus repaid", () => {
    const without = assessAffordability(data(), CAR, NOW);
    expect(without.advice[0]).toMatchObject({ subject: "Renmoney", openMinor: N(240_000) });
    expect(without.advice[0].loan).toBeUndefined();

    const r = assessAffordability(data({ loans: [loan()] }), CAR, NOW);
    expect(r.advice[0]).toEqual({
      kind: "debt", subject: "Renmoney", monthlyMinor: N(120_000), openMinor: N(360_000),
      text: "Clear Renmoney: ₦360k left, last payment 28 Dec. 3 of 6 instalments to go. After that, ₦120,000 a month is free.",
      loan: { id: "loan_1", outstandingMinor: N(360_000), balanceAsOf: new Date("2026-10-01T10:00:00Z"), endsOn: D("2026-12-28"), instalmentsLeft: 3, repaymentsSince: 0, repaidSinceMinor: 0n },
    });
    expect(r.advice.filter((a) => a.subject === "Renmoney")).toHaveLength(1);
  });

  it("rounds big balances to ₦1.28m style and works without an end date", () => {
    const big = assessAffordability(data({ loans: [loan({ outstandingMinor: 234_567_890n, endDate: null, instalmentsPaid: null, instalmentsTotal: null, instalmentMinor: N(400_000) })] }), CAR, NOW);
    expect(big.advice[0].text).toBe("Clear Renmoney: ₦2.35m left. At ₦400,000 a month that takes about 6 more months, then that money is free.");
  });

  it("names a loan the bank statements never showed", () => {
    const r = assessAffordability(data({ loans: [loan({ id: "loan_2", lender: "Carbon", outstandingMinor: N(90_000), instalmentMinor: null, instalmentsPaid: null, instalmentsTotal: null, nextDueDate: null, endDate: D("2026-11-20") })] }), CAR, NOW);
    const carbon = r.advice.find((a) => a.subject === "Carbon")!;
    expect(carbon.text).toBe("Clear Carbon: ₦90k left, last payment 20 Nov.");
    expect(carbon.openMinor).toBe(N(90_000));
  });

  it("flags a balance that is out of date when the bank shows a repayment after it was entered", () => {
    const paidSince = lender("Renmoney", [...RENMONEY_PAID.repayments.map((r) => [r.date.toISOString(), Number(r.amountMinor / 100n)] as [string, number]), ["2026-10-28T09:00:00Z", 120_000]]);
    const later = new Date("2026-11-02T09:00:00Z");
    const r = assessAffordability(data({ lenders: [paidSince], loans: [loan()] }), { ...CAR, horizon: NEXT_90 }, later);
    const line = r.advice.find((a) => a.subject === "Renmoney")!;
    expect(line.text).toMatch(/Your bank shows ₦120,000 repaid to Renmoney since you entered this on 1 Oct, so it may be down to ₦240k\. Update it under Loans\.$/);
    expect(line.loan).toMatchObject({ repaymentsSince: 1, repaidSinceMinor: N(120_000) });
    // The October instalment the bank already shows is not due again: November and December are.
    const renmoney = r.inputs.obligations.find((o) => o.name === "Renmoney")!;
    expect(renmoney.dueInWindowMinor).toBe(N(240_000));
    expect(renmoney.nextDue).toEqual(D("2026-11-28"));
  });

  it("counts the instalment only until the last payment, so the days after it look better", () => {
    const ending = loan({ outstandingMinor: N(120_000), instalmentsPaid: 5, nextDueDate: D("2026-10-28"), endDate: D("2026-10-28") });
    const before = assessAffordability(data(), { ...CAR, horizon: NEXT_90 }, NOW);
    const after = assessAffordability(data({ loans: [ending] }), { ...CAR, horizon: NEXT_90 }, NOW);
    const was = before.inputs.obligations.find((o) => o.name === "Renmoney")!;
    const now = after.inputs.obligations.find((o) => o.name === "Renmoney")!;
    expect(was.dueInWindowMinor).toBe(N(360_000));
    expect(now).toMatchObject({ dueInWindowMinor: N(120_000), loanId: "loan_1", endsOn: D("2026-10-28"), label: "Loan, last payment 28 Oct", kind: "recurring" });
    expect(after.projection.obligationsOutMinor).toBe(before.projection.obligationsOutMinor - N(240_000));
    expect(after.projection.endMinor).toBe(before.projection.endMinor + N(240_000));
    expect(after.projection.lowestMinor >= before.projection.lowestMinor).toBe(true);
    expect(after.notes).toContain("Renmoney's last payment is on 28 Oct. Its ₦120,000 a month is not counted after that.");
  });

  it("after the end date the loan stops counting against cash flow at all", () => {
    const afterEnd = new Date("2026-11-10T09:00:00Z");
    const months = [month("October 2026", 1_200_000, 700_000, 120_000), month("September 2026", 1_200_000, 700_000, 120_000), month("August 2026", 1_200_000, 700_000, 120_000)];
    const reps = lender("Renmoney", [["2026-08-28T09:00:00Z", 120_000], ["2026-09-28T09:00:00Z", 120_000], ["2026-10-28T09:00:00Z", 120_000]], [["2026-06-20T09:00:00Z", 600_000]]);
    const streams = [regular("Rent", "Housing", 250_000, "2026-10-25T09:00:00Z", "2026-11-25T09:00:00Z"), regular("Renmoney", "Debt", 120_000, "2026-10-28T09:00:00Z", "2026-11-28T09:00:00Z")];
    const base = data({ months, obligations: streams, lenders: [reps], cash: { minor: N(2_000_000), asOf: afterEnd, accounts: 1 } });
    const done = loan({ outstandingMinor: N(120_000), instalmentsPaid: 5, nextDueDate: D("2026-10-28"), endDate: D("2026-10-28") });

    const still = assessAffordability(base, { ...CAR, horizon: NEXT_90 }, afterEnd);
    const freed = assessAffordability({ ...base, loans: [done] }, { ...CAR, horizon: NEXT_90 }, afterEnd);
    expect(still.inputs.obligations.map((o) => o.name)).toContain("Renmoney");
    expect(freed.inputs.obligations.map((o) => o.name)).toEqual(["Rent"]);
    expect(freed.inputs.monthlyObligationsMinor).toBe(still.inputs.monthlyObligationsMinor - N(120_000));
    expect(freed.inputs.monthlyEverydayMinor).toBe(still.inputs.monthlyEverydayMinor);
    expect(freed.inputs.monthlySurplusMinor).toBe(still.inputs.monthlySurplusMinor + N(120_000));
    expect(freed.projection.lowestMinor > still.projection.lowestMinor).toBe(true);
    expect(freed.advice.some((a) => a.subject === "Renmoney")).toBe(false);
    expect(freed.notes).toContain("Renmoney is paid off (last payment 28 Oct), so its repayments are left out of your typical month.");

    // Closing it by hand does the same.
    const closed = assessAffordability({ ...base, loans: [loan({ status: "closed", closedAt: new Date("2026-10-29T09:00:00Z"), endDate: null })] }, { ...CAR, horizon: NEXT_90 }, afterEnd);
    expect(closed.inputs.monthlySurplusMinor).toBe(freed.inputs.monthlySurplusMinor);
  });

  it("a repayment well after a loan ended is a new loan, not the old one", () => {
    const renewed = lender("Renmoney", [["2026-09-28T09:00:00Z", 120_000], ["2026-10-28T09:00:00Z", 80_000]]);
    const r = assessAffordability(data({ lenders: [renewed], loans: [loan({ endDate: D("2026-09-28"), status: "closed", closedAt: D("2026-09-28") })] }), CAR, new Date("2026-11-02T09:00:00Z"));
    expect(r.notes).toContain("Ledger saw ₦80,000 repaid to Renmoney on 28 Oct, after the loan you entered was closed. If it is a new loan, add it under Loans.");
    expect(r.advice.find((a) => a.subject === "Renmoney")?.loan).toBeUndefined();
  });

  it("a new loan with no repayments yet adds its instalment without shrinking everyday spending", () => {
    const fresh = loan({ id: "loan_3", lender: "FairMoney", outstandingMinor: N(300_000), instalmentMinor: N(100_000), instalmentsPaid: 0, instalmentsTotal: 3, nextDueDate: D("2026-10-30"), endDate: null });
    const before = assessAffordability(data(), CAR, NOW);
    const after = assessAffordability(data({ loans: [fresh] }), CAR, NOW);
    expect(after.inputs.monthlyEverydayMinor).toBe(before.inputs.monthlyEverydayMinor);
    expect(after.inputs.monthlyObligationsMinor).toBe(before.inputs.monthlyObligationsMinor + N(100_000));
    expect(after.projection.obligationsOutMinor).toBe(before.projection.obligationsOutMinor + N(100_000));
  });

  it("a yes keeps one tip, now with the balance", () => {
    const r = assessAffordability(data({ loans: [loan()] }), { amountMinor: N(100_000), horizon: MONTH_END }, NOW);
    expect(r.verdict).toBe("yes");
    expect(r.advice).toHaveLength(1);
    expect(r.advice[0].text).toBe("You still repay Renmoney ₦120,000 a month, with ₦360k left and the last payment on 28 Dec. Clearing it first leaves more room for what comes next.");
  });
});

type Row = [day: number, debit: number, credit: number, remarks: string];
function statement(): string {
  const fmt = (n: number) => `"${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}"`;
  let bal = 500_000;
  const rows: string[] = [];
  for (const m of ["Jul", "Aug", "Sep"]) {
    const month: Row[] = [
      ...(m === "Jul" ? [[3, 0, 600_000, "NIP FROM RENMONEY MFB LOAN DISBURSEMENT"] as Row] : []),
      [10, 100_000, 0, "Instant Payment Outward TO RENMONEY MFB - JANE ADA DOE"],
      [15, 80_000, 0, "POS SHOPRITE LEKKI"],
      [24, 0, 1_000_000, "NIP ACME TECHNOLOGIES SALARY"],
      [25, 250_000, 0, "TRF RENT OLUWASEUN ADEYEMI"],
    ];
    for (const [day, debit, credit, remarks] of month) {
      const date = `${String(day).padStart(2, "0")}-${m}-2026`;
      bal += credit - debit;
      rows.push(`${date},,${date},${debit ? fmt(debit) : ""},${credit ? fmt(credit) : ""},${fmt(bal)},${remarks}`);
    }
  }
  return [
    "Guaranty Trust Bank Plc,,,,,,", "Customer Statement (SYNTHETIC TEST DATA),,,,,,", "Account Name,JANE ADA DOE,,,,,", "Account No,0123458888,,,,,",
    "Period,01-Jul-2026 to 25-Sep-2026,,,,,", ",,,,,,", "Trans. Date,Reference,Value Date,Debits,Credits,Balance,Remarks",
    "01-Jul-2026,,01-Jul-2026,,,\"500,000.00\",Opening Balance", ...rows,
  ].join("\n");
}

describe("matching statement repayments to a loan", () => {
  it("finds repayments to the lender after the balance was entered, and counts them when asked", async () => {
    const user = await db.user.create({ data: { email: "loans-match@test.dev" } });
    await importStatement(user.id, { name: "synthetic.csv", bytes: Buffer.from(statement()) });
    const fields = { lender: "Renmoney", outstandingMinor: N(400_000), instalmentMinor: N(100_000), instalmentsPaid: 2, instalmentsTotal: 6, nextDueDate: D("2026-09-10"), endDate: null, notes: null };
    const created = await createLoan(user.id, fields, new Date("2026-08-20T09:00:00Z"));

    const [view] = await listLoans(user.id);
    expect(view.since.map((r) => [r.date.toISOString().slice(0, 10), r.amountMinor])).toEqual([["2026-09-10", N(100_000)]]);
    expect(view.payoff).toEqual(D("2026-12-10"));

    const d = await loadAffordabilityData(user.id, new Date("2026-10-05T09:00:00Z"));
    expect(d.loans).toHaveLength(1);
    const r = assessAffordability(d, { amountMinor: N(2_700_000), horizon: MONTH_END }, new Date("2026-10-05T09:00:00Z"));
    expect(r.verdict).not.toBe("yes");
    expect(r.advice[0].text).toMatch(/^Clear Renmoney: ₦400k left, last payment 10 Dec\. 4 of 6 instalments to go\./);
    expect(r.advice[0].text).toMatch(/Your bank shows ₦100,000 repaid to Renmoney since you entered this on 20 Aug, so it may be down to ₦300k\./);

    const counted = await countRepayments(user.id, created.id);
    expect(counted).toMatchObject({ counted: 1, repaidMinor: N(100_000) });
    expect(counted!.loan).toMatchObject({ outstandingMinor: N(300_000), instalmentsPaid: 3, nextDueDate: D("2026-10-10"), status: "open" });
    expect((await listLoans(user.id))[0].since).toEqual([]);
    expect(await countRepayments(user.id, created.id)).toBeNull();
  });
});

describe("/api/v1/loans", () => {
  const req = (method: string, path: string, token: string | null, body?: unknown) => new Request(`http://localhost${path}`, {
    method,
    headers: { ...(body !== undefined && { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("needs a session and stays inside the user's own loans", async () => {
    expect((await listRoute(req("GET", "/api/v1/loans", null))).status).toBe(401);
    expect((await createRoute(req("POST", "/api/v1/loans", null, { lender: "Renmoney", outstandingMinor: "1" }))).status).toBe(401);
    const owner = await db.user.create({ data: { email: "loans-owner@test.dev" } });
    const other = await db.user.create({ data: { email: "loans-other@test.dev" } });
    const mine = await createLoan(owner.id, { lender: "FairMoney", outstandingMinor: N(50_000), instalmentMinor: null, instalmentsPaid: null, instalmentsTotal: null, nextDueDate: null, endDate: null, notes: null });
    const { token } = await issueSession(other.id);
    expect((await patchRoute(req("PATCH", `/api/v1/loans/${mine.id}`, token, { status: "closed" }), ctx(mine.id))).status).toBe(404);
    expect((await deleteRoute(req("DELETE", `/api/v1/loans/${mine.id}`, token), ctx(mine.id))).status).toBe(404);
    expect((await (await listRoute(req("GET", "/api/v1/loans", token))).json()).loans).toEqual([]);
  });

  it("adds, edits, closes and deletes a loan, with kobo as strings", async () => {
    const user = await db.user.create({ data: { email: "loans-api@test.dev" } });
    const { token } = await issueSession(user.id);
    expect((await createRoute(req("POST", "/api/v1/loans", token, { lender: "Kuda", outstandingMinor: "100" }))).status).toBe(400);
    expect((await createRoute(req("POST", "/api/v1/loans", token, { lender: "Renmoney", outstandingMinor: 100 }))).status).toBe(400);

    const res = await createRoute(req("POST", "/api/v1/loans", token, {
      lender: "renmoney", outstandingMinor: "36000050", instalmentMinor: "12000000", instalmentsPaid: 3, instalmentsTotal: 6, nextDueDate: "2026-10-28", notes: "School fees loan",
    }));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({
      lender: "Renmoney", outstandingMinor: "36000050", instalmentMinor: "12000000", instalmentsPaid: 3, instalmentsTotal: 6, instalmentsLeft: 3,
      nextDueDate: "2026-10-28T00:00:00.000Z", endDate: null, payoffDate: "2026-12-28T00:00:00.000Z", status: "open", notes: "School fees loan",
      repaymentsSince: { count: 0, totalMinor: "0", lastDate: null },
    });

    const list = await (await listRoute(req("GET", "/api/v1/loans", token))).json();
    expect(list.lenders).toEqual(LENDER_NAMES);
    expect(list.loans.map((l: { id: string }) => l.id)).toEqual([created.id]);

    const edited = await (await patchRoute(req("PATCH", `/api/v1/loans/${created.id}`, token, { lender: "Renmoney", outstandingMinor: "24000000", instalmentsPaid: 4, instalmentsTotal: 6, endDate: "2026-12-28" }), ctx(created.id))).json();
    expect(edited).toMatchObject({ outstandingMinor: "24000000", instalmentMinor: null, instalmentsPaid: 4, endDate: "2026-12-28T00:00:00.000Z", notes: null });
    expect((await patchRoute(req("PATCH", `/api/v1/loans/${created.id}`, token, { status: "paid" }), ctx(created.id))).status).toBe(400);
    const closed = await (await patchRoute(req("PATCH", `/api/v1/loans/${created.id}`, token, { status: "closed" }), ctx(created.id))).json();
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await deleteRoute(req("DELETE", `/api/v1/loans/${created.id}`, token), ctx(created.id))).status).toBe(200);
    expect(await db.loan.count({ where: { userId: user.id } })).toBe(0);
  });

  it("a client that only knows the lender and balance can still add a loan", async () => {
    const user = await db.user.create({ data: { email: "loans-minimal@test.dev" } });
    const { token } = await issueSession(user.id);
    const res = await createRoute(req("POST", "/api/v1/loans", token, { lender: "PalmCredit", outstandingMinor: "4500000" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ lender: "PalmCredit", instalmentMinor: null, instalmentsPaid: null, nextDueDate: null, payoffDate: null });
  });

  it("affordability keeps every field older clients read, and adds the loan beside them", async () => {
    const user = await db.user.create({ data: { email: "loans-afford@test.dev" } });
    await importStatement(user.id, { name: "synthetic.csv", bytes: Buffer.from(statement()) });
    // The route checks against today, so the loan's dates follow today too.
    const next = D(new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10));
    const end = addMonths(next, 1);
    await createLoan(user.id, { lender: "Renmoney", outstandingMinor: N(250_000), instalmentMinor: N(100_000), instalmentsPaid: 4, instalmentsTotal: 6, nextDueDate: next, endDate: end, notes: null }, new Date());
    const { token } = await issueSession(user.id);
    const body = await (await afford(req("POST", "/api/v1/affordability", token, { amountMinor: "300000000", horizon: "month_end" }))).json();
    expect(body.verdict).not.toBe("yes");
    const debt = body.advice.find((a: { kind: string }) => a.kind === "debt");
    // The shape an older client parses: kind, text, subject, and minor-unit strings. `loan` is the only addition.
    expect(Object.keys(debt).sort()).toEqual(["kind", "loan", "monthlyMinor", "openMinor", "subject", "text"]);
    expect(debt).toMatchObject({ kind: "debt", subject: "Renmoney", monthlyMinor: "10000000", openMinor: "25000000" });
    expect(debt.text).toMatch(/^Clear Renmoney: ₦250k left, last payment \d{1,2} [A-Z][a-z]{2}\. 2 of 6 instalments to go\./);
    expect(debt.loan).toMatchObject({ outstandingMinor: "25000000", endsOn: end.toISOString(), instalmentsLeft: 2, repaymentsSince: 0, repaidSinceMinor: "0" });
    for (const o of body.inputs.obligations) {
      expect(o).toMatchObject({ name: expect.any(String), category: expect.any(String), monthlyMinor: expect.stringMatching(/^\d+$/), dueInWindowMinor: expect.stringMatching(/^\d+$/), kind: "recurring" });
    }
    const other = body.advice.filter((a: { kind: string; subject: string | null; loan?: unknown }) => a.kind !== "debt" || a.subject !== "Renmoney");
    for (const a of other) expect(a.loan).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/[\u2014\u2013]/);
  });
});
