import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { issueSession } from "@/lib/auth";
import { importStatement } from "@/core/statement-import";
import { assessAffordability, loadAffordabilityData } from "@/core/affordability";
import { buildCadenceIndex, cadenceIds, cadenceLabel, cadenceOf, loadCadence, spendingSplit, type CadenceRow } from "@/core/cadence";
import { specificMonth, type RecurringItem } from "@/core/analytics";
import { GET as transactions } from "@/app/api/v1/transactions/route";
import { GET as summary } from "@/app/api/v1/summary/route";

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
