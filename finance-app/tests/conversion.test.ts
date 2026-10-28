import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { importStatement } from "@/core/statement-import";
import { answerQuestion, buildQuestions } from "@/core/review";
import { monthPeriod, summary } from "@/core/analytics";
import { convertToNgn, loadFxContext } from "@/core/fx/rates";

const CAD = Buffer.from(["Pesa Account Statement", "Wallet: CA001234561723", "Date,Transaction Details,Amount,Balance",
  "\"Sep 1, 2026\",PESAPEER INC / Payroll for Sep 2026,\"6,000.00\",\"6,000.00\"",
  "\"Sep 24, 2026\",Money transfer to ADA EZE / 0001234533 / Guaranty Trust Bank,(1000.00),\"5,000.00\"",
  "\"Sep 26, 2026\",Money transfer to ADA EZE / 0001234533 / Guaranty Trust Bank,(860.00),\"4,140.00\"",
  "\"Sep 28, 2026\",Money transfer to ADA EZE / 0001234533 / Guaranty Trust Bank,(170.00),\"3,970.00\""].join("\n"));
const NGN = Buffer.from(["Guaranty Trust Bank", "Account No,0001234533", "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
  "24-Sep-2026,P1,,973000.00,973000.00,0001-ADA EZE-110059-PESAPEER LTD .",
  "26-Sep-2026,P2,,829040.00,1802040.00,0002-ADA EZE-110059-PESAPEER LTD .",
  "28-Sep-2026,P3,,163912.30,1965952.30,0003-ADA EZE-110059-PESAPEER LTD ."].join("\n"));

async function setup(email: string) {
  const u = await db.user.create({ data: { email } });
  await importStatement(u.id, { name: "cad.csv", bytes: CAD });
  await importStatement(u.id, { name: "gtb.csv", bytes: NGN });
  await answerQuestion(u.id, "income", "pesapeer ltd", "salary"); // the user's earlier answer
  return u.id;
}

describe("salary moved between currencies", () => {
  it("links automatically, keeps the Salary label, and counts the salary once at the user's own rate", async () => {
    const userId = await setup("conv1@test.dev");
    expect((await buildQuestions(userId)).some((x) => x.kind === "conversion")).toBe(false); // clear evidence: no question
    // All three naira receipts are linked to the CAD sends, and still say Salary
    const naira = await db.transaction.findMany({ where: { userId, reference: { in: ["P1", "P2", "P3"] } } });
    expect(naira.every((t) => t.transferPairId && t.category === "Income" && t.subcategory === "Salary")).toBe(true);
    // Income = the CAD payroll once, converted at the rate that applies on that day.
    const s = await summary(userId, monthPeriod(new Date("2026-09-15T12:00:00Z")));
    const conv = convertToNgn(await loadFxContext(userId), 6000_00n, "CAD", new Date("2026-09-01T12:00:00Z"));
    expect(s.income).toBe(conv!.nairaMinor);
    expect(s.ratesUsed.map((r) => r.currency)).toEqual(["CAD"]);
    expect(s.unconverted).toEqual([]);
  });

  it("works the same before the user has labelled anything", async () => {
    const u = await db.user.create({ data: { email: "conv2@test.dev" } });
    await importStatement(u.id, { name: "cad.csv", bytes: CAD });
    await importStatement(u.id, { name: "gtb.csv", bytes: NGN });
    const p1 = await db.transaction.findFirstOrThrow({ where: { userId: u.id, reference: "P1" } });
    expect(p1).toMatchObject({ category: "Own transfer", subcategory: "Currency conversion" });
    const s = await summary(u.id, monthPeriod(new Date("2026-09-15T12:00:00Z")));
    const conv = convertToNgn(await loadFxContext(u.id), 6000_00n, "CAD", new Date("2026-09-01T12:00:00Z"));
    expect(s.income).toBe(conv!.nairaMinor);
  });

  it("foreign income uses a seeded market rate when the owner has no realised conversion yet", async () => {
    const u = await db.user.create({ data: { email: "conv3@test.dev" } });
    await importStatement(u.id, { name: "cad.csv", bytes: CAD });
    const s = await summary(u.id, monthPeriod(new Date("2026-09-15T12:00:00Z")));
    expect(s.income).toBeGreaterThan(0n);
    expect(s.unconverted).toEqual([]);
    expect(s.ratesUsed.map((r) => r.currency)).toEqual(["CAD"]);
  });
});
