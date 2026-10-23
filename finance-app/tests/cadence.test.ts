import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { issueSession } from "@/lib/auth";
import { importStatement } from "@/core/statement-import";
import { assessAffordability, loadAffordabilityData } from "@/core/affordability";
import { buildCadenceIndex, cadenceIds, cadenceLabel, cadenceOf, cadenceWhere, isEveryday, isOpaque, loadCadence, parseCadenceView, spendingSplit, type CadenceRow } from "@/core/cadence";
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
    lastDate: NOW, nextExpected: NOW, transactionIds: [id],
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
    expect(split.everyday).toMatchObject({ totalMinor: N(100_000), count: 1, opaque: { count: 0, totalMinor: 0n }, needsReview: false });
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

// Person payments whose narration names who was paid but not what for: the rules leave them on default Transfers.
const OPAQUE_AUGUST: Row[] = [
  [3, 60_000, 0, "Instant Payment Outward 000013260803 TO OPAY - CHIDI EMEKA OKEKE"],
  [17, 40_000, 0, "NIP TRANSFER TO PALMPAY - AMAKA NNEKA OBI"],
  [18, 12_000, 0, "POS CHICKEN REPUBLIC IKEJA"],
  [20, 30_000, 0, "PAYMENT / TRANSFER / TO / TUNDE BAKARE"],
  [21, 25_000, 0, "Instant Payment Outward 000013260821 TO OPAY - CHIDI EMEKA OKEKE"],
];
const OPAQUE_CSV = statement((m) => (m === "Aug" ? [...AUGUST, ...OPAQUE_AUGUST] : []));
const AUG = specificMonth(2026, 7);

describe("everyday spending drill-down", () => {
  it("breaks everyday down by category and payee, and its total is the Spending residual", async () => {
    const user = await db.user.create({ data: { email: "everyday-core@test.dev" } });
    await importStatement(user.id, { name: "synthetic.csv", bytes: Buffer.from(OPAQUE_CSV) });
    const cadence = await loadCadence(user.id, NOW);
    const split = await spendingSplit(user.id, AUG, cadence);
    // Loan to a friend (₦100k) + four person transfers (₦155k) + a meal (₦12k). The one-offs and regular payments are not in it.
    expect(split.everydayMinor).toBe(N(267_000));
    expect(split.everyday.totalMinor).toBe(split.everydayMinor);
    expect(split.everyday.byCategory.reduce((t, c) => t + c.totalMinor, 0n)).toBe(split.everydayMinor);
    expect(split.everyday.count).toBe(6);
    expect(split.everyday.byCategory[0]).toEqual({ name: "Transfers", totalMinor: N(155_000), count: 4 });
    expect(split.everyday.byCategory.map((c) => c.name)).toContain("Debt");
    expect(split.everyday.byPayee[0]).toEqual({ name: "John Okafor", totalMinor: N(100_000), count: 1 });
    expect(split.everyday.byPayee.find((p) => p.name === "Chidi Emeka Okeke")).toEqual({ name: "Chidi Emeka Okeke", totalMinor: N(85_000), count: 2 });
    expect(split.everyday.opaque).toEqual({ count: 4, totalMinor: N(155_000) });
    expect(split.everyday.needsReview).toBe(true);

    // The transactions view lists exactly these rows.
    const view = await listTransactions(user.id, { from: AUG.from, to: AUG.to, cadence: await cadenceWhere(user.id, cadence, "everyday") }, 1, 50);
    expect(view.total).toBe(6);
    expect(view.rows.every((r) => isEveryday(r, cadence))).toBe(true);
    const ids = new Set(await cadenceIds(user.id, cadence, "everyday"));
    expect(view.rows.every((r) => ids.has(r.id))).toBe(true);
    const transfers = await listTransactions(user.id, { from: AUG.from, to: AUG.to, category: "Transfers", cadence: await cadenceWhere(user.id, cadence, "everyday") }, 1, 50);
    expect(transfers.total).toBe(4);

    // A month before recurring detection looks back gets no everyday breakdown.
    const old = await spendingSplit(user.id, specificMonth(2025, 0), cadence);
    expect(old.everyday).toMatchObject({ totalMinor: 0n, count: 0, needsReview: false });
  });

  it("the mobile API adds cadence=everyday, the breakdown, Review and Re-run without changing existing fields", async () => {
    const user = await db.user.create({ data: { email: "everyday-api@test.dev" } });
    await importStatement(user.id, { name: "synthetic.csv", bytes: Buffer.from(OPAQUE_CSV) });
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
    type Tx = { description: string; category: string; cadence: string | null };
    const rows = everyday.body.transactions as Tx[];
    expect(rows.every((t) => t.cadence === null && t.category !== "Own transfer")).toBe(true);

    const home = await call(summary, "/api/v1/summary?month=2026-08");
    expect(home.status).toBe(200);
    const e = home.body.spendingSplit.everyday;
    expect(e).toMatchObject({
      totalMinor: expect.stringMatching(/^\d+$/), count: expect.any(Number), needsReview: expect.any(Boolean), reviewQuestions: expect.any(Number),
      opaque: { count: expect.any(Number), totalMinor: expect.stringMatching(/^\d+$/) },
    });
    expect(e.totalMinor).toBe(home.body.spendingSplit.everydayMinor);
    expect((e.byCategory as { totalMinor: string }[]).every((c) => /^\d+$/.test(c.totalMinor))).toBe(true);
    // Recurring detection looks back 6 months from today, so the labels depend on the real clock.
    if (home.body.spendingSplit.labelled) {
      expect(rows.map((t) => t.description).filter((d) => /CHIDI|AMAKA|TUNDE/.test(d))).toHaveLength(4);
      expect(e).toMatchObject({ totalMinor: "26700000", count: 6, needsReview: true, opaque: { count: 4, totalMinor: "15500000" } });
      expect(e.reviewQuestions).toBeGreaterThanOrEqual(3);
      expect(e.byPayee).toContainEqual({ name: "Chidi Emeka Okeke", totalMinor: "8500000", count: 2 });
    }

    // Review: the same questions as the web page, answered by the phone.
    const review = await call(reviewGet, "/api/v1/review");
    expect(review.status).toBe(200);
    type Q = { kind: string; key: string; title: string; totalMinor: string; options: { value: string }[]; allowsOther: boolean };
    const chidi = (review.body.questions as Q[]).find((q) => q.key === "chidi emeka okeke")!;
    expect(chidi).toMatchObject({ kind: "person", totalMinor: "8500000", allowsOther: true });
    expect(chidi.options.map((o) => o.value)).toContain("family");
    expect((await call(reviewPost, "/api/v1/review", { kind: "guess", key: "x", value: "family" })).status).toBe(400);
    expect((await call(reviewPost, "/api/v1/review", { kind: "person", key: chidi.key, value: "other" })).status).toBe(400);
    expect((await call(reviewPost, "/api/v1/review", { kind: "person", key: chidi.key, value: "nonsense" })).status).toBe(400);
    const answered = await call(reviewPost, "/api/v1/review", { kind: "person", key: chidi.key, value: "family" });
    expect(answered).toEqual({ status: 200, body: { updated: 2 } });

    // Chidi now counts as Family, so less of everyday is unexplained and Review is no longer pushed.
    const after = await spendingSplit(user.id, AUG, await loadCadence(user.id, NOW));
    expect(after.everyday.opaque).toEqual({ count: 2, totalMinor: N(70_000) });
    expect(after.everyday.byCategory.find((c) => c.name === "Family")).toEqual({ name: "Family", totalMinor: N(85_000), count: 2 });
    expect(after.everyday.needsReview).toBe(false);

    // Re-run categorization keeps the answer.
    const rerun = await call(categorizePost, "/api/v1/categorize", {});
    expect(rerun.status).toBe(200);
    expect(rerun.body).toMatchObject({ checked: expect.any(Number), changed: expect.any(Number), message: expect.stringContaining("manual corrections") });
    const chidiRows = await db.transaction.findMany({ where: { userId: user.id, counterparty: "Chidi Emeka Okeke" } });
    expect(chidiRows.every((r) => r.category === "Family")).toBe(true);

    const anon = await categorizePost(new Request("http://localhost/api/v1/categorize", { method: "POST" }));
    expect(anon.status).toBe(401);
  });
});
