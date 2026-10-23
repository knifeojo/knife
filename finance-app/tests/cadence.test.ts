import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { issueSession } from "@/lib/auth";
import { importStatement } from "@/core/statement-import";
import { OBLIGATION_CATEGORIES, assessAffordability, loadAffordabilityData } from "@/core/affordability";
import { buildCadenceIndex, cadenceIds, cadenceLabel, cadenceOf, cadenceWhere, isEveryday, payeeWhere, isOpaque, loadCadence, parseCadenceView, spendingSplit, type CadenceRow } from "@/core/cadence";
import { listTransactions, specificMonth, type RecurringItem } from "@/core/analytics";
import { GET as transactions } from "@/app/api/v1/transactions/route";
import { GET as summary } from "@/app/api/v1/summary/route";
import { GET as reviewGet, POST as reviewPost } from "@/app/api/v1/review/route";
import { POST as categorizePost } from "@/app/api/v1/categorize/route";

// Synthetic figures only. ₦ amounts are converted to kobo with BigInt.
const N = (naira: number) => BigInt(naira) * 100n;
const NOW = new Date("2026-10-10T09:00:00Z");

describe("cadence: the rule", () => {
  const stream = (id: string, category: string, type: "DEBIT" | "CREDIT" = "DEBIT"): RecurringItem => ({
    key: id, name: `Stream ${id}`, category, type, averageMinor: N(1), occurrences: 2, months: 2,
    lastDate: NOW, nextExpected: NOW, transactionIds: [id], kind: "fixed", aliases: [],
  });
  const since = new Date("2026-04-30T23:00:00Z");
  const index = buildCadenceIndex([stream("rent", "Housing"), stream("gym", "Healthcare"), stream("pay", "Income", "CREDIT")], N(1_000_000), since);
  const row = (over: Partial<CadenceRow>): CadenceRow => ({
    id: "x", type: "DEBIT", currency: "NGN", transferPairId: null, category: "Shopping", subcategory: null, amountMinor: N(200_000), transactionDate: NOW, ...over,
  });

  it("uses Afford's one-off threshold: ₦50,000 or a tenth of typical income, whichever is more", () => {
    expect(index.oneOffMinMinor).toBe(N(100_000));
    expect(buildCadenceIndex([], 0n, since).oneOffMinMinor).toBe(N(50_000));
  });

  it("labels regular streams, bills among them, and big single spends", () => {
    expect(cadenceLabel(row({ id: "rent", category: "Housing" }), index)).toBe("recurring_bill");
    expect(cadenceLabel(row({ id: "gym", category: "Healthcare" }), index)).toBe("recurring");
    expect(cadenceLabel(row({ id: "pay", type: "CREDIT", category: "Income" }), index)).toBe("recurring");
    expect(cadenceOf(row({}), index)).toBe("one_off");
    expect(cadenceOf(row({ amountMinor: N(99_999) }), index)).toBeNull();
  });

  it("never calls a loan repayment, fee, own transfer, wallet withdrawal, linked transfer or credit a one-off", () => {
    for (const over of [
      { category: "Debt" }, { category: "Fees" }, { category: "Own transfer", subcategory: "Savings" },
      { category: "Transfers", subcategory: "Withdrawal" }, { transferPairId: "other" }, { type: "CREDIT", category: "Income" }, { currency: "USD" },
    ]) expect(cadenceOf(row(over), index), JSON.stringify(over)).toBeNull();
  });

  it("does not label rows older than recurring detection looks back", () => {
    expect(cadenceOf(row({ transactionDate: new Date("2026-03-01T09:00:00Z") }), index)).toBeNull();
  });

  it("everyday is every other spending debit: not regular, not a one-off, not an own transfer or linked leg", () => {
    expect(isEveryday(row({ amountMinor: N(5_000) }), index)).toBe(true);
    expect(isEveryday(row({ amountMinor: N(30_000), category: "Transfers" }), index)).toBe(true);
    expect(isEveryday(row({ category: "Fees" }), index)).toBe(true); // never a one-off, however big
    expect(isEveryday(row({ currency: "USD" }), index)).toBe(true); // foreign spending is never a one-off
    expect(isEveryday(row({ id: "rent", category: "Housing" }), index)).toBe(false);
    expect(isEveryday(row({ id: "gym", category: "Healthcare" }), index)).toBe(false);
    expect(isEveryday(row({}), index)).toBe(false); // ₦200,000 single spend: one-off
    for (const over of [
      { category: "Own transfer", amountMinor: N(5_000) }, { transferPairId: "other", amountMinor: N(5_000) },
      { type: "CREDIT", category: "Income", amountMinor: N(5_000) }, { amountMinor: N(5_000), transactionDate: new Date("2026-03-01T09:00:00Z") },
    ]) expect(isEveryday(row(over), index), Object.keys(over).join(",")).toBe(false);
  });

  it("only a rules default Transfers/Other label is opaque", () => {
    expect(isOpaque({ category: "Transfers", classificationSource: "default" })).toBe(true);
    expect(isOpaque({ category: "Other", classificationSource: "default" })).toBe(true);
    expect(isOpaque({ category: "Transfers", classificationSource: "user" })).toBe(false); // answered "Friend"
    expect(isOpaque({ category: "Transfers", classificationSource: "ai" })).toBe(false);
    expect(isOpaque({ category: "Shopping", classificationSource: "default" })).toBe(false);
  });

  it("parses the everyday view and rejects unknown ones", () => {
    expect(parseCadenceView("everyday")).toBe("everyday");
    expect(parseCadenceView("one_off")).toBe("one_off");
    expect(parseCadenceView("weekly")).toBeUndefined();
    expect(parseCadenceView(null)).toBeUndefined();
  });
});

type Row = [day: number, debit: number, credit: number, remarks: string];
function statement(extra: (month: string) => Row[]) {
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
    "Account No,0123458888,,,,,",
    "Period,01-Jul-2026 to 25-Sep-2026,,,,,",
    ",,,,,,",
    "Trans. Date,Reference,Value Date,Debits,Credits,Balance,Remarks",
    "01-Jul-2026,,01-Jul-2026,,,\"500,000.00\",Opening Balance",
    ...rows,
  ].join("\n");
}

// The known misclassifications, in August: a transfer to someone who banks with Carbon, a PiggyVest
// deposit, and a memo-only "LOAN TO" a friend. Plus one real one-off purchase.
const AUGUST: Row[] = [
  [8, 200_000, 0, "Instant Payment Outward 000013260808 TO CARBON - JOHN SMITH"],
  [9, 300_000, 0, "Instant Payment Outward 000013260809 TO PIGGYVEST SAVINGS"],
  [10, 100_000, 0, "Instant Payment Outward 000013260810 LOAN TO OPAY - JOHN OKAFOR"],
  [12, 450_000, 0, "TRF TO ZBN - FOUANI SHOWROOM"],
];
const CSV = statement((m) => (m === "Aug" ? AUGUST : []));

describe("cadence and categories from an imported statement", () => {
  it("files the known misclassifications correctly, and Afford sees the same thing", async () => {
    const user = await db.user.create({ data: { email: "cadence-ledger@test.dev" } });
    await importStatement(user.id, { name: "synthetic.csv", bytes: Buffer.from(CSV) });
    const rows = await db.transaction.findMany({ where: { userId: user.id, transactionDate: { gte: new Date("2026-08-07T00:00:00Z"), lt: new Date("2026-08-13T00:00:00Z") } } });
    const by = (s: string) => rows.find((r) => r.description.includes(s))!;
    expect(by("CARBON")).toMatchObject({ category: "Transfers", counterparty: "John Smith", merchantName: "John Smith" });
    expect(by("PIGGYVEST")).toMatchObject({ category: "Own transfer", subcategory: "Savings", merchantName: "PiggyVest" });
    expect(by("LOAN TO")).toMatchObject({ category: "Debt", subcategory: "Loans" });

    const d = await loadAffordabilityData(user.id, NOW);
    // Only the real lender. Not Carbon (John only banks there) and not John Okafor (a memo-only loan).
    expect(d.lenders.map((l) => l.name)).toEqual(["FairMoney"]);
    // PiggyVest is the user's own money, so August spending excludes it.
    expect(d.months.find((m) => m.label === "August 2026")!.spendingMinor).toBe(N(1_230_000));

    const r = assessAffordability(d, { amountMinor: N(5_000_000), horizon: { kind: "month_end" } }, NOW);
    expect(r.advice.filter((a) => a.kind === "debt").map((a) => a.subject)).toEqual(["FairMoney"]);
    const afford = r.inputs.oneOffs.map((o) => o.name).sort();
    expect(afford).toEqual(["Fouani Showroom", "John Smith"]);

    // The same one-offs and the same recurring payments outside Afford.
    const cadence = await loadCadence(user.id, NOW);
    expect(cadence.oneOffMinMinor).toBe(r.inputs.oneOffMinMinor);
    const oneOffIds = await cadenceIds(user.id, cadence, "one_off");
    const oneOffNames = (await db.transaction.findMany({ where: { id: { in: oneOffIds } } })).map((t) => t.merchantName).sort();
    expect(oneOffNames).toEqual(afford);
    const bills = new Set([...cadence.recurring.values()].filter((s) => s.bill).map((s) => s.name));
    expect([...bills].sort()).toEqual(r.inputs.obligations.map((o) => o.name).sort());

    const split = await spendingSplit(user.id, specificMonth(2026, 7), cadence);
    expect(split).toMatchObject({
      totalMinor: N(1_230_000),
      recurringBillsMinor: N(400_000), // family, FairMoney, rent
      recurringOtherMinor: N(80_000), // Shoprite every month: regular, not a bill
      oneOffMinor: N(650_000),
      everydayMinor: N(100_000), // the loan to a friend
      labelled: true,
    });
    expect(split.everyday).toMatchObject({ totalMinor: N(100_000), count: 1 });
    expect(split.oneOffs.map((o) => [o.name, o.amountMinor])).toEqual([["Fouani Showroom", N(450_000)], ["John Smith", N(200_000)]]);
    expect(split.byCategory.get("Food")).toEqual({ recurringMinor: N(80_000), oneOffMinor: 0n });
  });

  it("the mobile API adds cadence without changing existing fields", async () => {
    const user = await db.user.create({ data: { email: "cadence-api@test.dev" } });
    await importStatement(user.id, { name: "synthetic.csv", bytes: Buffer.from(CSV) });
    const { token } = await issueSession(user.id);
    const get = async (handler: (r: Request) => Promise<Response>, path: string) => {
      const res = await handler(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } }));
      return { status: res.status, body: await res.json() };
    };

    const all = await get(transactions, "/api/v1/transactions?pageSize=100");
    expect(all.status).toBe(200);
    type Tx = { description: string; category: string; amountMinor: string; cadence: string | null; recurringBill: boolean };
    const txs = all.body.transactions as Tx[];
    expect(txs.every((t) => typeof t.amountMinor === "string" && "cadence" in t && typeof t.recurringBill === "boolean")).toBe(true);
    // Recurring detection looks back 6 months from today, so the rows are dated relative to the real clock.
    if (all.body.cadenceSince <= "2026-07-01") {
      expect(txs.find((t) => t.description.includes("FOUANI"))).toMatchObject({ cadence: "one_off", recurringBill: false });
      expect(txs.find((t) => t.description.startsWith("TRF RENT"))).toMatchObject({ cadence: "recurring", recurringBill: true });
      expect(txs.find((t) => t.description.includes("SHOPRITE"))).toMatchObject({ cadence: "recurring", recurringBill: false });
      expect(txs.find((t) => t.description.includes("PIGGYVEST"))).toMatchObject({ cadence: null });
    }
    expect(typeof all.body.oneOffMinMinor).toBe("string");

    const oneOffs = await get(transactions, "/api/v1/transactions?cadence=one_off");
    expect((oneOffs.body.transactions as Tx[]).every((t) => t.cadence === "one_off")).toBe(true);
    const regular = await get(transactions, "/api/v1/transactions?cadence=recurring");
    expect((regular.body.transactions as Tx[]).every((t) => t.cadence === "recurring")).toBe(true);
    expect((await get(transactions, "/api/v1/transactions?cadence=weekly")).status).toBe(400);

    const home = await get(summary, "/api/v1/summary?month=2026-08");
    expect(home.status).toBe(200);
    expect(home.body.expensesMinor).toBe("123000000");
    expect(home.body.spendingSplit).toMatchObject({ oneOffMinMinor: expect.stringMatching(/^\d+$/), labelled: expect.any(Boolean) });
    const cats = home.body.spendingByCategory as { category: string; totalMinor: string; recurringMinor: string; oneOffMinor: string }[];
    expect(cats.every((c) => /^\d+$/.test(c.recurringMinor) && /^\d+$/.test(c.oneOffMinor))).toBe(true);
    expect(cats.map((c) => c.category)).not.toContain("Own transfer");
  });
});

// A month dominated by person transfers whose narrations name who was paid but not what for, spelled differently
// each month, plus a shop paid several times a month through POS, web and transfer lines.
function personStatement(): string {
  const months: [string, Row[]][] = [
    ["Jul", [
      [3, 8_000, 0, "POS SHOPRITE LEKKI"], [12, 12_000, 0, "POS/WEB PMNT @ SHOPRITE IKEJA CITY MALL LA NG"], [20, 10_000, 0, "TRF TO SHOPRITE NIGERIA LTD"],
      [2, 40_000, 0, "Instant Payment Outward 000013260702 TO OPAY - GRACE NNEKA EZE"],
    ]],
    ["Aug", [
      [3, 8_000, 0, "POS SHOPRITE LEKKI"], [12, 12_000, 0, "POS/WEB PMNT @ SHOPRITE IKEJA CITY MALL LA NG"], [20, 10_000, 0, "TRF TO SHOPRITE NIGERIA LTD"],
      [2, 70_000, 0, "NIP TRANSFER TO PALMPAY - EZE GRACE"],
      [4, 60_000, 0, "Instant Payment Outward 000013260804 TO OPAY - CHIDI EMEKA OKEKE"],
      [15, 45_000, 0, "Instant Payment Outward 000013260815 WARDROBE TO ACCESS - EMEKA JOHN OBI"],
      [17, 40_000, 0, "NIP TRANSFER TO PALMPAY - AMAKA NNEKA OBI"],
      [19, 30_000, 0, "PAYMENT / TRANSFER / TO / TUNDE BAKARE"],
      [21, 25_000, 0, "Instant Payment Outward 000013260821 TO OPAY - OKEKE CHIDI E"],
    ]],
    ["Sep", [
      [3, 8_000, 0, "POS SHOPRITE LEKKI"], [12, 12_000, 0, "POS/WEB PMNT @ SHOPRITE IKEJA CITY MALL LA NG"], [20, 10_000, 0, "TRF TO SHOPRITE NIGERIA LTD"],
      [2, 25_000, 0, "PAYMENT / TRANSFER / TO / GRACE N EZE"],
    ]],
  ];
  const rows: string[] = [];
  let bal = 500_000;
  const fmt = (n: number) => `"${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}"`;
  for (const [m, extra] of months) {
    const month: Row[] = [[24, 0, 1_000_000, "NIP ACME TECHNOLOGIES SALARY"], [25, 250_000, 0, "TRF RENT TO OLUWASEUN ADEYEMI"], ...extra];
    for (const [day, debit, credit, remarks] of month.sort((x, y) => x[0] - y[0])) {
      const date = `${String(day).padStart(2, "0")}-${m}-2026`;
      bal += credit - debit;
      rows.push(`${date},,${date},${debit ? fmt(debit) : ""},${credit ? fmt(credit) : ""},${fmt(bal)},${remarks}`);
    }
  }
  return [
    "Guaranty Trust Bank Plc,,,,,,", "Customer Statement (SYNTHETIC TEST DATA),,,,,,", "Account Name,JANE ADA DOE,,,,,", "Account No,0123459999,,,,,",
    "Period,01-Jul-2026 to 30-Sep-2026,,,,,", ",,,,,,", "Trans. Date,Reference,Value Date,Debits,Credits,Balance,Remarks",
    "01-Jul-2026,,01-Jul-2026,,,\"500,000.00\",Opening Balance", ...rows,
  ].join("\n");
}
const PERSON_CSV = personStatement();
const AUG = specificMonth(2026, 7);

describe("matched payees, recurring by name, and the everyday drill-down", () => {
  it("finds recurring payees by matched name: fixed, variable-amount and frequent", async () => {
    const user = await db.user.create({ data: { email: "payees-recurring@test.dev" } });
    await importStatement(user.id, { name: "synthetic.csv", bytes: Buffer.from(PERSON_CSV) });
    const cadence = await loadCadence(user.id, NOW);
    const by = (re: RegExp) => cadence.streams.find((st) => st.type === "DEBIT" && re.test(st.name))!;
    expect(by(/Oluwaseun/)).toMatchObject({ kind: "fixed", averageMinor: N(250_000), months: 3 });
    // ₦40k, ₦70k, ₦25k to one relative under three spellings: one variable monthly stream, not three misses.
    const grace = by(/Grace|Eze/);
    expect(grace).toMatchObject({ kind: "variable", averageMinor: N(40_000), occurrences: 3, months: 3, category: "Transfers" });
    expect([grace.name, ...grace.aliases].sort()).toEqual(["Eze Grace", "Grace Nneka Eze", "Gracen Eze"]);
    // Shoprite through POS, web and a transfer: several times a month, about ₦30k a month.
    expect(by(/Shoprite/)).toMatchObject({ kind: "frequent", averageMinor: N(30_000), occurrences: 9, months: 3 });
    expect(cadence.recurring.get(by(/Shoprite/).transactionIds[0])!.bill).toBe(false);

    // Afford plans for monthly payments only: a frequent shop is not a fixed obligation.
    const afford = await loadAffordabilityData(user.id, NOW);
    const planned = afford.obligations.filter((o) => OBLIGATION_CATEGORIES.includes(o.category)).map((o) => o.name);
    expect(planned).toContain("Oluwaseun Adeyemi");
    expect(planned).not.toContain("Shoprite");
  });

  it("splits a month by matched payee and breaks everyday down by category and payee", async () => {
    const user = await db.user.create({ data: { email: "payees-split@test.dev" } });
    await importStatement(user.id, { name: "synthetic.csv", bytes: Buffer.from(PERSON_CSV) });
    const cadence = await loadCadence(user.id, NOW);
    const split = await spendingSplit(user.id, AUG, cadence);
    expect(split).toMatchObject({
      totalMinor: N(550_000), recurringBillsMinor: N(250_000), recurringOtherMinor: N(100_000), oneOffMinor: 0n, everydayMinor: N(200_000),
    });
    expect(split.everyday.totalMinor).toBe(split.everydayMinor);
    expect(split.everyday.byCategory.reduce((t, c) => t + c.totalMinor, 0n)).toBe(split.everydayMinor);
    expect(split.everyday.byCategory).toEqual([{ name: "Transfers", totalMinor: N(200_000), count: 5 }]);
    expect(split.everyday.byPayee[0]).toEqual({ name: "Chidi Emeka Okeke", totalMinor: N(85_000), count: 2 });

    // "What I spent on": one line per person or shop, with every spelling matched.
    const payee = (re: RegExp) => split.payees.find((x) => re.test(x.name))!;
    expect(split.payees[0]).toMatchObject({ name: "Oluwaseun Adeyemi", category: "Housing", regular: "fixed", recurringMinor: N(250_000) });
    expect(payee(/Chidi/)).toMatchObject({ totalMinor: N(85_000), count: 2, everydayMinor: N(85_000), regular: null, unlabelledMinor: N(85_000), variants: ["Okeke Chidie"] });
    expect(payee(/Grace|Eze/)).toMatchObject({ totalMinor: N(70_000), regular: "variable", recurringMinor: N(70_000), unlabelledMinor: N(70_000) });
    expect(payee(/Shoprite/)).toMatchObject({ totalMinor: N(30_000), count: 3, category: "Food", regular: "frequent", unlabelledMinor: 0n });
    expect(split.payees.reduce((t, x) => t + x.totalMinor, 0n)).toBe(split.totalMinor);

    // Most of the month went to people with no stated purpose: push Review.
    expect(split.unlabelled).toEqual({ count: 6, totalMinor: N(270_000), needsReview: true });

    // The everyday and payee views list exactly these rows.
    const view = await listTransactions(user.id, { from: AUG.from, to: AUG.to, cadence: await cadenceWhere(user.id, cadence, "everyday") }, 1, 50);
    expect(view.total).toBe(5);
    expect(view.rows.every((r) => isEveryday(r, cadence))).toBe(true);
    const ids = new Set(await cadenceIds(user.id, cadence, "everyday"));
    expect(view.rows.every((r) => ids.has(r.id))).toBe(true);
    const chidi = await listTransactions(user.id, { payee: await payeeWhere(user.id, "Chidi Emeka Okeke") }, 1, 50);
    expect(chidi.rows.map((r) => r.counterparty).sort()).toEqual(["Chidi Emeka Okeke", "Okeke Chidie"]);
    const shoprite = await listTransactions(user.id, { from: AUG.from, to: AUG.to, payee: await payeeWhere(user.id, "Shoprite") }, 1, 50);
    expect(shoprite.total).toBe(3);

    // A month before recurring detection looks back gets no breakdown.
    const old = await spendingSplit(user.id, specificMonth(2025, 0), cadence);
    expect(old.everyday).toMatchObject({ totalMinor: 0n, count: 0 });
    expect(old.unlabelled.needsReview).toBe(false);
  });

  it("the mobile API adds payees, named recurring groups, cadence=everyday, Review and Re-run without changing existing fields", async () => {
    const user = await db.user.create({ data: { email: "payees-api@test.dev" } });
    await importStatement(user.id, { name: "synthetic.csv", bytes: Buffer.from(PERSON_CSV) });
    const { token } = await issueSession(user.id);
    const call = async (handler: (r: Request) => Promise<Response>, path: string, body?: object) => {
      const res = await handler(new Request(`http://localhost${path}`, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${token}`, ...(body && { "content-type": "application/json" }) },
        body: body ? JSON.stringify(body) : undefined,
      }));
      return { status: res.status, body: await res.json() };
    };

    const everyday = await call(transactions, "/api/v1/transactions?cadence=everyday&from=2026-08-01&to=2026-08-31");
    expect(everyday.status).toBe(200);
    type Tx = { description: string; category: string; cadence: string | null; counterparty: string | null };
    expect((everyday.body.transactions as Tx[]).every((t) => t.cadence === null && t.category !== "Own transfer")).toBe(true);
    const chidiTx = await call(transactions, "/api/v1/transactions?payee=Chidi%20Emeka%20Okeke");
    expect((chidiTx.body.transactions as Tx[]).map((t) => t.counterparty).sort()).toEqual(["Chidi Emeka Okeke", "Okeke Chidie"]);

    const home = await call(summary, "/api/v1/summary?month=2026-08");
    expect(home.status).toBe(200);
    const split = home.body.spendingSplit;
    expect(split.everyday).toMatchObject({ totalMinor: expect.stringMatching(/^\d+$/), count: expect.any(Number) });
    expect(split.everyday.totalMinor).toBe(split.everydayMinor);
    expect(split.unlabelled).toMatchObject({ count: expect.any(Number), totalMinor: expect.stringMatching(/^\d+$/), needsReview: expect.any(Boolean), reviewQuestions: expect.any(Number) });
    type Payee = { name: string; totalMinor: string; regular: string | null; variants: string[]; unnamed: boolean };
    expect((split.payees as Payee[]).every((x) => /^\d+$/.test(x.totalMinor) && Array.isArray(x.variants) && typeof x.unnamed === "boolean")).toBe(true);
    type Stream = { name: string; kind: string; bill: boolean; averageMinor: string; aliases: string[] };
    const streams = home.body.recurring as Stream[];
    expect(streams.every((st) => ["fixed", "variable", "frequent"].includes(st.kind) && /^\d+$/.test(st.averageMinor))).toBe(true);
    // Recurring detection looks back 6 months from today, so the labels depend on the real clock.
    if (split.labelled) {
      expect(streams.find((st) => /Shoprite/.test(st.name))).toMatchObject({ kind: "frequent", bill: false, averageMinor: "3000000" });
      expect(streams.find((st) => /Oluwaseun/.test(st.name))).toMatchObject({ kind: "fixed", bill: true });
      expect(split.unlabelled).toMatchObject({ count: 6, totalMinor: "27000000", needsReview: true });
      expect(split.unlabelled.reviewQuestions).toBeGreaterThanOrEqual(3);
      expect(split.payees).toContainEqual(expect.objectContaining({ name: "Chidi Emeka Okeke", totalMinor: "8500000", variants: ["Okeke Chidie"] }));
    }

    // Review: full narrations and purpose words, the same questions as the web page.
    const review = await call(reviewGet, "/api/v1/review");
    expect(review.status).toBe(200);
    type Q = { kind: string; key: string; totalMinor: string; examples: string[]; narrationHints: { words: string; category: string }[]; options: { value: string }[]; allowsOther: boolean };
    const questions = review.body.questions as Q[];
    const emeka = questions.find((q) => q.key === "emeka john obi")!;
    expect(emeka.examples).toEqual(["Instant Payment Outward 000013260815 WARDROBE TO ACCESS - EMEKA JOHN OBI"]);
    expect(emeka.narrationHints).toEqual([{ words: "wardrobe", category: "Housing", subcategory: "Wardrobe" }]);
    const chidi = questions.find((q) => q.key.includes("chidi"))!;
    expect(chidi).toMatchObject({ kind: "person", totalMinor: "8500000", allowsOther: true, narrationHints: [] });
    expect(chidi.examples).toHaveLength(2);
    expect(chidi.options.map((o) => o.value)).toContain("family");
    expect((await call(reviewPost, "/api/v1/review", { kind: "guess", key: "x", value: "family" })).status).toBe(400);
    expect((await call(reviewPost, "/api/v1/review", { kind: "person", key: chidi.key, value: "other" })).status).toBe(400);
    expect((await call(reviewPost, "/api/v1/review", { kind: "person", key: chidi.key, value: "nonsense" })).status).toBe(400);
    expect(await call(reviewPost, "/api/v1/review", { kind: "person", key: chidi.key, value: "family" })).toEqual({ status: 200, body: { updated: 2 } });
    // A narration hint is answered like "Other": the purpose words become the label.
    expect(await call(reviewPost, "/api/v1/review", { kind: "person", key: emeka.key, value: "other", otherText: "wardrobe", otherCategory: "Housing" })).toEqual({ status: 200, body: { updated: 1 } });

    const after = await spendingSplit(user.id, AUG, await loadCadence(user.id, NOW));
    expect(after.unlabelled).toMatchObject({ count: 3, totalMinor: N(140_000) });
    expect(after.payees.find((x) => /Chidi/.test(x.name))).toMatchObject({ category: "Family", unlabelledMinor: 0n });
    expect(after.everyday.byCategory.find((c) => c.name === "Housing")).toEqual({ name: "Housing", totalMinor: N(45_000), count: 1 });

    // Re-run categorization keeps the answers.
    const rerun = await call(categorizePost, "/api/v1/categorize", {});
    expect(rerun.status).toBe(200);
    expect(rerun.body).toMatchObject({ checked: expect.any(Number), changed: expect.any(Number), message: expect.stringContaining("manual corrections") });
    const chidiRows = await db.transaction.findMany({ where: { userId: user.id, counterparty: { in: ["Chidi Emeka Okeke", "Okeke Chidie"] } } });
    expect(chidiRows.map((r) => r.category)).toEqual(["Family", "Family"]);
    expect((await categorizePost(new Request("http://localhost/api/v1/categorize", { method: "POST" }))).status).toBe(401);
  });
});
