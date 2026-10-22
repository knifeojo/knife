import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { guessFromRaw, importStatement, openIssues, resolveIssueByAdding, resolveIssueByIgnoring } from "@/core/statement-import";
import { reconcile } from "@/core/statements";

// Row 3 has a garbled amount ("N/A"), so it can't be read. The running balance exposes the ₦5,000 gap.
const BROKEN = Buffer.from([
  "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
  "01-Sep-2026,R1,,100000.00,100000.00,SALARY",
  "02-Sep-2026,R2,20000.00,,80000.00,UBER TRIP",
  "03-Sep-2026,R3,N/A,,75000.00,SHOPRITE LEKKI",
  "04-Sep-2026,R4,10000.00,,65000.00,NETFLIX",
].join("\n"));

describe("reconcile", () => {
  const tx = (type: string, a: number, b: number) => ({ type, amountMinor: BigInt(a), balanceAfterMinor: BigInt(b) });
  it("finds the missing money in oldest-first and newest-first statements", () => {
    const oldest = [tx("CREDIT", 100, 100), tx("DEBIT", 20, 80), tx("DEBIT", 10, 65)];
    expect(reconcile(oldest)).toMatchObject({ breaks: 1, gapMinor: 5n });
    expect(reconcile([...oldest].reverse())).toMatchObject({ breaks: 1, gapMinor: 5n });
    expect(reconcile([tx("CREDIT", 100, 100), tx("DEBIT", 20, 80)])).toMatchObject({ breaks: 0, gapMinor: 0n });
  });

  it("counts a balance that is wrong in the middle and right again on the next row once", () => {
    // 1,030,000 − 10,000 = 1,020,000, but the middle balance says 900,000 (off by 120,000).
    // The following row is back on the real chain (1,020,000 − 5,000 = 1,015,000), so the gap is
    // 120,000 once, not 240,000.
    const chain = [tx("CREDIT", 1_030_000, 1_030_000), tx("DEBIT", 10_000, 900_000), tx("DEBIT", 5_000, 1_015_000)];
    expect(reconcile(chain)).toMatchObject({ breaks: 1, gapMinor: 120_000n });
    const twoHoles = [tx("CREDIT", 100, 100), tx("DEBIT", 10, 80), tx("DEBIT", 10, 60)];
    expect(reconcile(twoHoles)).toMatchObject({ breaks: 2, gapMinor: 20n });
  });
});

describe("no silent data loss", () => {
  it("keeps unreadable rows, flags the import as partial with the exact gap, and lets the user add them back", async () => {
    const u = await db.user.create({ data: { email: "loss@test.dev" } });
    const r = await importStatement(u.id, { name: "broken.csv", bytes: BROKEN }, { institution: "GTBank" });
    expect(r).toMatchObject({ created: 3, complete: false, balanceBreaks: 1, gap: "₦5,000.00" });
    const run = await db.syncRun.findFirstOrThrow({ where: { userId: u.id } });
    expect(run).toMatchObject({ status: "partial", gapMinor: 500_000n });

    const [issue] = await openIssues(u.id);
    expect(issue).toMatchObject({ rowNumber: 4, reason: "Unreadable amount" });
    expect(issue.rawText).toContain("SHOPRITE LEKKI");
    const guess = guessFromRaw(issue.rawText);
    expect(guess).toMatchObject({ date: "2026-09-03", amount: "75000.00", description: "SHOPRITE LEKKI" });

    // The user corrects the amount (the guess picked up the balance) and adds it
    await resolveIssueByAdding(u.id, issue.id, { date: "2026-09-03", direction: "out", amount: "5000", description: "SHOPRITE LEKKI" });
    expect(await openIssues(u.id)).toHaveLength(0);
    const added = await db.transaction.findFirstOrThrow({ where: { userId: u.id, source: "manual" } });
    expect(added).toMatchObject({ type: "DEBIT", amountMinor: 500_000n, category: "Food" });
    const debits = await db.transaction.aggregate({ where: { userId: u.id, type: "DEBIT" }, _sum: { amountMinor: true } });
    expect(debits._sum.amountMinor).toBe(3_500_000n); // 20,000 + 5,000 + 10,000: ledger now matches the statement
  });

  it("re-importing the same file does not create duplicate issues for rows already handled", async () => {
    const u = await db.user.create({ data: { email: "loss2@test.dev" } });
    await importStatement(u.id, { name: "broken.csv", bytes: BROKEN }, { institution: "GTBank" });
    const [issue] = await openIssues(u.id);
    await resolveIssueByIgnoring(u.id, issue.id);
    expect(await openIssues(u.id)).toHaveLength(0);
  });

  it("a user cannot resolve someone else's issue", async () => {
    const a = await db.user.create({ data: { email: "loss3@test.dev" } });
    const b = await db.user.create({ data: { email: "loss4@test.dev" } });
    await importStatement(a.id, { name: "broken.csv", bytes: BROKEN }, { institution: "GTBank" });
    const [issue] = await openIssues(a.id);
    await expect(resolveIssueByAdding(b.id, issue.id, { date: "2026-09-03", direction: "out", amount: "5000", description: "x" })).rejects.toThrow();
    await resolveIssueByIgnoring(b.id, issue.id);
    expect(await openIssues(a.id)).toHaveLength(1);
  });

  it("a clean statement is complete and creates no issues", async () => {
    const u = await db.user.create({ data: { email: "loss5@test.dev" } });
    const clean = Buffer.from(["Trans. Date,Reference,Debits,Credits,Balance,Remarks", "01-Sep-2026,R1,,100000.00,100000.00,SALARY", "02-Sep-2026,R2,20000.00,,80000.00,UBER"].join("\n"));
    expect(await importStatement(u.id, { name: "ok.csv", bytes: clean }, { institution: "GTBank" })).toMatchObject({ complete: true, gap: null });
    expect(await openIssues(u.id)).toHaveLength(0);
  });
});
