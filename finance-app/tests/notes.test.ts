import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { importStatement } from "@/core/statement-import";
import { applyNoteLabel, matchNotes, monthFromHeading, parseNoteAmount, parseNotes, pickClosest } from "@/core/notes";
import { specificMonth } from "@/core/analytics";

const naira = (n: number) => BigInt(n * 100);

describe("reading rough notes", () => {
  it("reads amounts the way people jot them", () => {
    expect(parseNoteAmount("750")).toBe(naira(750_000));
    expect(parseNoteAmount("1.3")).toBe(naira(1_300_000));
    expect(parseNoteAmount("1m")).toBe(naira(1_000_000));
    expect(parseNoteAmount("90 k")).toBe(naira(90_000));
    expect(parseNoteAmount("400k")).toBe(naira(400_000));
    expect(parseNoteAmount("1,200,000")).toBe(naira(1_200_000));
  });

  it("keeps sub-items under their heading", () => {
    const lines = parseNotes("Expense Sept\nSaving500\nLoan\n    Rm 1.3\n    Fm 400\nHouse light and service charge 400 k");
    expect(lines.map((l) => l.label)).toEqual(["Saving", "Loan", "House light and service charge"]);
    expect(lines[0].amountMinor).toBe(naira(500_000));
    expect(lines[1].children.map((c) => [c.label, c.amountMinor])).toEqual([["Rm", naira(1_300_000)], ["Fm", naira(400_000)]]);
    expect(monthFromHeading("Expense Sept", 2026)?.label).toBe("September 2026");
  });

  it("picks the closest payment, not every small extra", () => {
    const xs = [{ amountMinor: naira(750_000) }, { amountMinor: naira(20_000) }];
    expect(pickClosest(xs, naira(750_000))).toEqual([xs[0]]);
    const parents = [200_000, 150_000, 150_000, 20_000].map((n) => ({ amountMinor: naira(n) }));
    expect(pickClosest(parents, naira(500_000)).length).toBe(3);
  });
});

describe("matching notes to the ledger", () => {
  const CSV = Buffer.from([
    "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
    "01-Sep-2026,N1,,5000000.00,5000000.00,SALARY",
    "02-Sep-2026,N2,1000000.00,,4000000.00,RENT AND DD FROM EZE ADA TO MENSAH ABENA",
    "03-Sep-2026,N3,1280000.00,,2720000.00,Instant Payment Outward LOAN TO REMB - ADA EZE",
    "04-Sep-2026,N4,40000.00,,2680000.00,AIRTIME COLLECTION SALE",
    "05-Sep-2026,N5,300000.00,,2380000.00,Instant Payment Outward CLEANING TO OPAY - BOLA ADE",
  ].join("\n"));

  it("explains payments without changing amounts or the user's own labels", async () => {
    const user = await db.user.create({ data: { email: `notes-${Date.now()}@x.test` } });
    await importStatement(user.id, { name: "s.csv", bytes: CSV }, { institution: "GTBank" });
    const cleaning = await db.transaction.findFirstOrThrow({ where: { userId: user.id, description: { contains: "CLEANING" } } });
    await db.transaction.update({ where: { id: cleaning.id }, data: { category: "Housing", subcategory: "Cleaner", classificationSource: "user" } });

    const res = await matchNotes(user.id, specificMonth(2026, 8), parseNotes("Rent 500\nDd 500k\nLoan\n  Rm 1.3\nCleaning 400k\nFlex 1m"));
    const by = Object.fromEntries(res.map((r) => [r.label, r]));
    // One ₦1M payment explains two lines
    expect(by.Rent.matched[0].id).toBe(by.Dd.matched[0].id);
    expect(by.Rent.status).toBe("matches");
    expect(by.Rm.status).toBe("matches");
    expect(by.Rm.matched).toHaveLength(1); // airtime isn't swept in
    expect(by.Cleaning.matched[0].userLabelled).toBe(true);
    expect(by.Flex.status).toBe("not in your statements");

    const before = await db.transaction.findMany({ where: { userId: user.id }, select: { id: true, amountMinor: true, transactionDate: true } });
    const n = await applyNoteLabel(user.id, [...by.Rm.matched, ...by.Cleaning.matched].map((m) => m.id), by.Rm.proposal!);
    expect(n).toBe(1); // the user's own "Cleaner" label is kept
    const after = await db.transaction.findMany({ where: { userId: user.id }, select: { id: true, amountMinor: true, transactionDate: true } });
    expect(after).toEqual(before);
    expect((await db.transaction.findUniqueOrThrow({ where: { id: cleaning.id } })).subcategory).toBe("Cleaner");
    // Nothing is created from notes alone
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(5);
  });
});
