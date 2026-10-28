import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { issueSession } from "@/lib/auth";
import { POST as signup } from "@/app/api/v1/auth/signup/route";
import { POST as upload } from "@/app/api/v1/statements/route";
import { GET as transactions } from "@/app/api/v1/transactions/route";
import { GET as summary } from "@/app/api/v1/summary/route";
import { GET as overview } from "@/app/api/v1/overview/route";
import { GET as categoryGet } from "@/app/api/v1/categories/[category]/route";
import { GET as reviewGet } from "@/app/api/v1/review/route";
import { decodeTxCursor, encodeTxCursor, periodFromYearMonth, previousCalendarMonth, specificMonth } from "@/core/analytics";

const SAMPLE = readFileSync("public/sample-gtbank-statement.csv");
const N = (naira: number) => BigInt(naira) * 100n;
let n = 0;

function authed(path: string, token: string) {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } });
}

async function bodyOf(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

async function seed() {
  const user = await db.user.create({ data: { email: `ov-${++n}@ledger.test` } });
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
  const { token } = await issueSession(user.id);
  return { user, account, token };
}

async function addTx(
  userId: string,
  accountId: string,
  data: {
    date: string;
    type: "DEBIT" | "CREDIT";
    amount: bigint;
    category: string;
    subcategory?: string;
    merchant: string;
    at?: Date;
    transferPairId?: string;
  },
) {
  return db.transaction.create({
    data: {
      userId,
      accountId,
      source: "fixture",
      sourceTransactionId: `ov-src-${++n}`,
      fingerprint: `ov-fp-${++n}`,
      transactionDate: data.at ?? new Date(`${data.date}T12:00:00Z`),
      type: data.type,
      amountMinor: data.amount,
      currency: "NGN",
      description: data.merchant,
      merchantName: data.merchant,
      category: data.category,
      subcategory: data.subcategory ?? null,
      classificationSource: "rule",
      classificationConfidence: 0.9,
      transferPairId: data.transferPairId,
    },
  });
}

describe("month helpers", () => {
  it("parses YYYY-MM and steps back one Lagos month", () => {
    const oct = periodFromYearMonth("2026-10");
    if ("error" in oct) throw new Error(oct.error);
    expect(oct.label).toBe("October 2026");
    expect(previousCalendarMonth(oct).label).toBe("September 2026");
    expect(periodFromYearMonth("2026-13")).toEqual({ error: "month must be YYYY-MM" });
    expect(specificMonth(2026, -1).label).toBe("December 2025");
  });

  it("round-trips a cursor", () => {
    const date = new Date("2026-10-23T12:00:00.000Z");
    const encoded = encodeTxCursor(date, "clxxxxxxxxxxxxxxxx");
    expect(decodeTxCursor(encoded)).toEqual({ date, id: "clxxxxxxxxxxxxxxxx" });
    expect(decodeTxCursor("%%%")).toBeNull();
  });
});

describe("GET /api/v1/overview", () => {
  it("matches /summary in and out on the same month, including exclusions", async () => {
    const { user, account, token } = await seed();
    await addTx(user.id, account.id, { date: "2026-10-01", type: "CREDIT", amount: N(1_250_000), category: "Income", subcategory: "Salary", merchant: "Example Payroll Ltd" });
    await addTx(user.id, account.id, { date: "2026-10-02", type: "DEBIT", amount: N(350_000), category: "Housing", subcategory: "Rent", merchant: "Sample Estate Ltd" });
    await addTx(user.id, account.id, { date: "2026-10-03", type: "DEBIT", amount: N(45_000), category: "Housing", subcategory: "Home services", merchant: "Example Cleaning Co" });
    await addTx(user.id, account.id, { date: "2026-10-04", type: "DEBIT", amount: N(25_000), category: "Housing", subcategory: "Generator & diesel", merchant: "Demo Diesel Shop" });
    await addTx(user.id, account.id, { date: "2026-10-05", type: "DEBIT", amount: N(180_000), category: "Food", subcategory: "Groceries", merchant: "Sample Foods Ltd" });
    await addTx(user.id, account.id, { date: "2026-10-06", type: "DEBIT", amount: N(120_000), category: "Transport", merchant: "Example Transit" });
    await addTx(user.id, account.id, { date: "2026-10-07", type: "DEBIT", amount: N(95_000), category: "Family", merchant: "Sample Relative" });
    await addTx(user.id, account.id, { date: "2026-10-08", type: "DEBIT", amount: N(60_000), category: "Utilities", merchant: "Example Power Co" });
    await addTx(user.id, account.id, { date: "2026-10-09", type: "DEBIT", amount: N(105_000), category: "Shopping", merchant: "Demo Market" });
    // These must not move in/out: own transfer, paired legs, reversal, debt proceeds, fee refund.
    const own = await addTx(user.id, account.id, { date: "2026-10-10", type: "DEBIT", amount: N(50_000), category: "Own transfer", merchant: "Example Savings" });
    await addTx(user.id, account.id, { date: "2026-10-10", type: "CREDIT", amount: N(50_000), category: "Own transfer", merchant: "Example Savings", transferPairId: own.id });
    await addTx(user.id, account.id, { date: "2026-10-11", type: "DEBIT", amount: N(20_000), category: "Food", subcategory: "Reversal", merchant: "Reversed POS" });
    await addTx(user.id, account.id, { date: "2026-10-12", type: "CREDIT", amount: N(80_000), category: "Debt", subcategory: "Loan proceeds", merchant: "Example Lender" });
    await addTx(user.id, account.id, { date: "2026-09-15", type: "DEBIT", amount: N(910_000), category: "Housing", subcategory: "Rent", merchant: "Sample Estate Ltd" });

    const home = await bodyOf(await summary(authed("/api/v1/summary?month=2026-10", token)));
    const ov = await bodyOf(await overview(authed("/api/v1/overview?month=2026-10", token)));
    expect(ov.inMinor).toBe(home.incomeMinor);
    expect(ov.outMinor).toBe(home.expensesMinor);
    expect(ov.inMinor).toBe(N(1_250_000).toString());
    expect(ov.outMinor).toBe(N(980_000).toString());
    expect(ov.leftMinor).toBe(N(270_000).toString());
    expect(ov.prevOutMinor).toBe(N(910_000).toString());
    expect(ov.keptBp).toBe(2160);
    const cats = ov.categories as { category: string; totalMinor: string; shareBp: number }[];
    expect(cats.map((c) => c.category)).toEqual(["Housing", "Food", "Transport", "Shopping", "Family", "Utilities"]);
    expect(cats[0]).toMatchObject({ totalMinor: N(420_000).toString(), shareBp: 4286 });
    const sources = ov.incomeSources as { name: string }[];
    expect(sources[0].name).toBe("Example Payroll Ltd");
  });

  it("matches /summary in and out on the sample statement fixture", async () => {
    const res = await signup(new Request("http://localhost/api/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++n}` },
      body: JSON.stringify({ email: `sample-ov-${n}@ledger.test`, password: "correct-horse" }),
    }));
    const token = String((await bodyOf(res)).token ?? "");
    const form = new FormData();
    form.set("file", new File([SAMPLE], "sample-gtbank-statement.csv", { type: "text/csv" }));
    await upload(new Request("http://localhost/api/v1/statements", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form }));
    const home = await bodyOf(await summary(authed("/api/v1/summary?month=2026-09", token)));
    const ov = await bodyOf(await overview(authed("/api/v1/overview?month=2026-09", token)));
    expect(ov.inMinor).toBe(home.incomeMinor);
    expect(ov.outMinor).toBe(home.expensesMinor);
    expect(ov.inMinor).toBe("198361100");
  });

  it("rejects a bad month", async () => {
    const { token } = await seed();
    expect((await overview(authed("/api/v1/overview?month=2026-13", token))).status).toBe(400);
  });
});

describe("GET /api/v1/categories/{category}", () => {
  it("ranks subcategories and reports share of out plus a 6-month average", async () => {
    const { user, account, token } = await seed();
    await addTx(user.id, account.id, { date: "2026-10-02", type: "DEBIT", amount: N(350_000), category: "Housing", subcategory: "Rent", merchant: "Sample Estate Ltd" });
    await addTx(user.id, account.id, { date: "2026-10-03", type: "DEBIT", amount: N(45_000), category: "Housing", subcategory: "Home services", merchant: "Example Cleaning Co" });
    await addTx(user.id, account.id, { date: "2026-10-04", type: "DEBIT", amount: N(25_000), category: "Housing", subcategory: "Generator & diesel", merchant: "Demo Diesel Shop" });
    await addTx(user.id, account.id, { date: "2026-10-05", type: "DEBIT", amount: N(180_000), category: "Food", merchant: "Sample Foods Ltd" });
    await addTx(user.id, account.id, { date: "2026-09-02", type: "DEBIT", amount: N(350_000), category: "Housing", subcategory: "Rent", merchant: "Sample Estate Ltd" });
    await addTx(user.id, account.id, { date: "2026-08-02", type: "DEBIT", amount: N(350_000), category: "Housing", subcategory: "Rent", merchant: "Sample Estate Ltd" });

    const res = await categoryGet(authed("/api/v1/categories/Housing?month=2026-10", token), { params: Promise.resolve({ category: "Housing" }) });
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.totalMinor).toBe(N(420_000).toString());
    expect(body.shareBp).toBe(7000);
    expect(body.avg6mMinor).toBe(((N(420_000) + N(350_000) + N(350_000)) / 6n).toString());
    const subs = body.subcategories as { name: string; totalMinor: string; count: number }[];
    expect(subs.map((s) => s.name)).toEqual(["Rent", "Home services", "Generator & diesel"]);
    expect(subs[0]).toMatchObject({ totalMinor: N(350_000).toString(), count: 1 });
    expect((await categoryGet(authed("/api/v1/categories/NotACategory?month=2026-10", token), { params: Promise.resolve({ category: "NotACategory" }) })).status).toBe(400);
  });
});

describe("GET /api/v1/transactions cursor paging", () => {
  it("pages stably with equal timestamps and has no duplicates or gaps", async () => {
    const { user, account, token } = await seed();
    const at = new Date("2026-10-23T12:00:00.000Z");
    const names = ["Alpha Shop", "Bravo Cafe", "Charlie Mart", "Delta Store", "Echo Kiosk"];
    for (const merchant of names) {
      await addTx(user.id, account.id, { date: "2026-10-23", type: "DEBIT", amount: N(1_000), category: "Shopping", merchant, at });
    }
    await addTx(user.id, account.id, { date: "2026-10-22", type: "DEBIT", amount: N(2_000), category: "Food", merchant: "Earlier Cafe" });

    const first = await bodyOf(await transactions(authed("/api/v1/transactions?limit=2", token)));
    expect(first.total).toBeUndefined();
    expect(first.page).toBeUndefined();
    expect((first.transactions as { id: string }[]).length).toBe(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const days = first.dayTotals as { date: string; outMinor: string }[];
    expect(days.some((d) => d.date === "2026-10-23" && d.outMinor === N(5_000).toString())).toBe(true);

    const seen: string[] = [];
    let cursor = null as string | null;
    for (let i = 0; i < 10; i++) {
      const q = cursor ? `/api/v1/transactions?limit=2&cursor=${encodeURIComponent(cursor)}` : "/api/v1/transactions?limit=2";
      const page = await bodyOf(await transactions(authed(q, token)));
      const rows = page.transactions as { id: string; merchantName: string }[];
      for (const row of rows) seen.push(row.id);
      cursor = (page.nextCursor as string | null) ?? null;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);

    const offset = await bodyOf(await transactions(authed("/api/v1/transactions?page=1&pageSize=50", token)));
    expect(offset.total).toBe(6);
    expect(offset.page).toBe(1);
    expect(offset.pageSize).toBe(50);
    expect((offset.transactions as { id: string }[]).map((t) => t.id).sort()).toEqual([...seen].sort());
  });

  it("filters by category, subcategory, month and direction", async () => {
    const { user, account, token } = await seed();
    await addTx(user.id, account.id, { date: "2026-10-03", type: "DEBIT", amount: N(45_000), category: "Housing", subcategory: "Home services", merchant: "Example Cleaning Co" });
    await addTx(user.id, account.id, { date: "2026-10-02", type: "DEBIT", amount: N(350_000), category: "Housing", subcategory: "Rent", merchant: "Sample Estate Ltd" });
    await addTx(user.id, account.id, { date: "2026-10-01", type: "CREDIT", amount: N(1_250_000), category: "Income", subcategory: "Salary", merchant: "Example Payroll Ltd" });
    await addTx(user.id, account.id, { date: "2026-09-02", type: "DEBIT", amount: N(10_000), category: "Housing", subcategory: "Rent", merchant: "Old Rent" });

    const housing = await bodyOf(await transactions(authed("/api/v1/transactions?limit=30&category=Housing&month=2026-10", token)));
    expect((housing.transactions as { merchantName: string }[]).map((t) => t.merchantName)).toEqual(["Example Cleaning Co", "Sample Estate Ltd"]);

    const rent = await bodyOf(await transactions(authed("/api/v1/transactions?limit=30&category=Housing&subcategory=Rent&month=2026-10", token)));
    expect((rent.transactions as { merchantName: string }[])).toHaveLength(1);
    expect((rent.transactions as { merchantName: string }[])[0].merchantName).toBe("Sample Estate Ltd");

    const incoming = await bodyOf(await transactions(authed("/api/v1/transactions?limit=30&direction=in&month=2026-10", token)));
    expect((incoming.transactions as { type: string }[]).every((t) => t.type === "CREDIT")).toBe(true);
    expect((incoming.transactions as unknown[]).length).toBe(1);

    expect((await transactions(authed("/api/v1/transactions?limit=30&direction=sideways", token))).status).toBe(400);
    expect((await transactions(authed("/api/v1/transactions?cursor=not-a-cursor", token))).status).toBe(400);
    expect((await transactions(authed("/api/v1/transactions?limit=0", token))).status).toBe(400);
  });
});

describe("GET /api/v1/review cursor", () => {
  it("returns nextCursor null on an empty queue and rejects a bad cursor", async () => {
    const { token } = await seed();
    const page = await bodyOf(await reviewGet(authed("/api/v1/review?limit=10", token)));
    expect(page.questions).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect((await reviewGet(authed("/api/v1/review?cursor=nope", token))).status).toBe(400);
  });
});
