import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { importStatement } from "@/core/statement-import";
import { monthPeriod, summary } from "@/core/analytics";
import { findPairs, mentionsInstitution } from "@/core/transfers";

const GTB = Buffer.from(["Guaranty Trust Bank", "Account No,0001234533", "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
  "02-Sep-2026,A1,,1000000.00,1000000.00,W5WM-MONIE MFB-DEEL INC",
  "03-Sep-2026,A2,100000.00,,900000.00,Instant Payment Outward 01 X FROM EZE SEUN SAMUEL TO KUDA - EZE SEUN SAMUEL",
  "04-Sep-2026,A3,200000.00,,700000.00,Instant Payment Outward 02 SAVE FROM EZE SEUN SAMUEL TO OPAY",
  "05-Sep-2026,A4,50000.00,,650000.00,Instant Payment Outward 03 LUNCH FROM EZE SEUN SAMUEL TO OPAY - TOLU ADE",
  "06-Sep-2026,A5,75000.00,,575000.00,Instant Payment Outward 04 GIFT FROM EZE SEUN SAMUEL TO ZBN - CHIDI OKAFOR"].join("\n"));
const KUDA = Buffer.from(["Kuda Microfinance Bank", "Account Number,2001119876", "Date,Description,Money Out,Money In,Balance",
  "03/09/2026,TRANSFER FROM EZE SEUN SAMUEL,,100000,100000"].join("\n"));
const OPAY = Buffer.from(["OPay", "Account Number,8031234567", "Date,Description,Debit,Credit,Balance",
  "04/09/2026,Transfer from Guaranty Trust Bank,,200000,200000",
  // Coincidence: someone else sends exactly ₦75,000 two days after the unrelated gift. Must NOT pair.
  "07/09/2026,Transfer from BOLA ADE,,75000,275000"].join("\n"));

describe("own-account transfer pairing", () => {
  it("removes double counting across banks, with or without names in the narration", async () => {
    const u = await db.user.create({ data: { email: "pairs@test.dev" } });
    for (const [n, b] of [["gtb.csv", GTB], ["kuda.csv", KUDA], ["opay.csv", OPAY]] as const) await importStatement(u.id, { name: n, bytes: b });
    const s = await summary(u.id, monthPeriod(new Date("2026-09-15T12:00:00Z")));
    expect(Number(s.income) / 100).toBe(1_075_000); // Deel + the unrelated ₦75K from Bola
    expect(Number(s.expenses) / 100).toBe(125_000); // lunch + gift
    const a3 = await db.transaction.findFirstOrThrow({ where: { userId: u.id, reference: "A3" } });
    expect(a3).toMatchObject({ category: "Own transfer", classificationSource: "pair" });
    const opayLeg = await db.transaction.findUniqueOrThrow({ where: { id: a3.transferPairId! } });
    expect(opayLeg.transferPairId).toBe(a3.id);
    const gift = await db.transaction.findFirstOrThrow({ where: { userId: u.id, reference: "A5" } });
    expect(gift.transferPairId).toBeNull();
  });

  it("re-importing does not create new pairs or break existing ones", async () => {
    const u = await db.user.create({ data: { email: "pairs2@test.dev" } });
    for (const [n, b] of [["gtb.csv", GTB], ["opay.csv", OPAY]] as const) await importStatement(u.id, { name: n, bytes: b });
    await importStatement(u.id, { name: "opay.csv", bytes: OPAY });
    expect(await db.transaction.count({ where: { userId: u.id, classificationSource: "pair" } })).toBe(2);
  });
});

describe("pairing rules", () => {
  const leg = (o: Partial<Parameters<typeof findPairs>[0][number]>) => ({
    id: Math.random().toString(), accountId: "a", institution: "GTBank", type: "DEBIT", amountMinor: 100n, currency: "NGN",
    transactionDate: new Date("2026-09-03T12:00:00Z"), description: "", counterparty: null, category: "Transfers", classificationSource: "default", ...o,
  });
  it("needs a clue beyond amount and date", () => {
    expect(findPairs([leg({}), leg({ accountId: "b", institution: "Kuda", type: "CREDIT", description: "FROM BOLA" })], [])).toHaveLength(0);
    expect(findPairs([leg({ description: "TO KUDA" }), leg({ accountId: "b", institution: "Kuda", type: "CREDIT" })], [])).toHaveLength(1);
  });
  it("respects a user label on either leg", () => {
    const d = leg({ description: "TO KUDA", category: "Family", classificationSource: "user" });
    expect(findPairs([d, leg({ accountId: "b", institution: "Kuda", type: "CREDIT" })], [])).toHaveLength(0);
  });
  it("never pairs within one account or across currencies or far-apart dates", () => {
    expect(findPairs([leg({ description: "TO KUDA" }), leg({ type: "CREDIT" })], [])).toHaveLength(0);
    expect(findPairs([leg({ description: "TO KUDA" }), leg({ accountId: "b", institution: "Kuda", type: "CREDIT", currency: "USD" })], [])).toHaveLength(0);
    expect(findPairs([leg({ description: "TO KUDA" }), leg({ accountId: "b", institution: "Kuda", type: "CREDIT", transactionDate: new Date("2026-09-08T12:00:00Z") })], [])).toHaveLength(0);
  });
  it("recognises bank short codes", () => {
    expect(mentionsInstitution("... TO ZBN - FOUANI", "Zenith Bank")).toBe(true);
    expect(mentionsInstitution("Transfer from Guaranty Trust Bank", "GTBank")).toBe(true);
    expect(mentionsInstitution("W5WM-MONIE MFB-DEEL INC", "Moniepoint")).toBe(true);
  });
});

describe("cross-currency own transfers", () => {
  const leg = (o: Partial<Parameters<typeof findPairs>[0][number]>) => ({
    id: Math.random().toString(), accountId: "cad", institution: "Pesa", type: "DEBIT", amountMinor: 100n, currency: "CAD",
    transactionDate: new Date("2026-09-24T12:00:00Z"), description: "Money transfer to ADA EZE / 0123 / Guaranty Trust Bank", counterparty: null,
    category: "Transfers", classificationSource: "default", ...o,
  });
  const ngn = (amountNaira: number, day: string) => leg({ accountId: "gtb", institution: "GTBank", type: "CREDIT", currency: "NGN", amountMinor: BigInt(Math.round(amountNaira * 100)), transactionDate: new Date(`${day}T12:00:00Z`), description: "TRANSFER FROM PESAPEER LTD" });
  const cad = (amountCad: number, day: string) => leg({ amountMinor: BigInt(Math.round(amountCad * 100)), transactionDate: new Date(`${day}T12:00:00Z`) });

  it("pairs CAD sends with naira receipts at a consistent rate", () => {
    const legs = [cad(1000, "2026-09-24"), ngn(973000, "2026-09-24"), cad(860, "2026-09-26"), ngn(829040, "2026-09-26"), cad(170, "2026-09-28"), ngn(163912.3, "2026-09-28")];
    const pairs = findPairs(legs, []);
    expect(pairs).toHaveLength(3);
    expect(pairs.map((p) => [Number(p.debit.amountMinor) / 100, Number(p.credit.amountMinor) / 100]).sort()).toEqual([[1000, 973000], [170, 163912.3], [860, 829040]]);
  });

  it("pairs a single own-name foreign debit with the next-day naira credit", () => {
    const d = cad(100, "2026-09-24");
    d.category = "Own transfer";
    d.counterparty = "Ada Eze";
    const c = ngn(155000, "2026-09-25");
    const pairs = findPairs([d, c], ["Ada Eze"]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].clue).toMatch(/own-name/);
  });

  it("pairs a Deel withdrawal with the next-day DEEL INC credit", () => {
    const d = leg({
      id: "deel-d",
      accountId: "usd",
      institution: "Deel",
      currency: "USD",
      amountMinor: 100_00n,
      transactionDate: new Date("2026-10-05T12:00:00Z"),
      description: "Money transfer to Ada Eze / Deel withdrawal",
    });
    const c = leg({
      id: "deel-c",
      accountId: "gtb",
      institution: "GTBank",
      type: "CREDIT",
      currency: "NGN",
      amountMinor: 154_000_00n,
      transactionDate: new Date("2026-10-06T09:00:00Z"),
      description: "NIP CREDIT DEEL INC",
      counterparty: "DEEL INC",
    });
    const pairs = findPairs([d, c], []);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].clue).toMatch(/payout landing/);
  });

  it("needs 3+ consistent conversions; an income label does not block, a spending label does", () => {
    expect(findPairs([cad(1000, "2026-09-24"), ngn(973000, "2026-09-24")], [])).toHaveLength(0);
    const salary = { ...ngn(973000, "2026-09-24"), category: "Income", classificationSource: "user" };
    expect(findPairs([cad(1000, "2026-09-24"), salary, cad(860, "2026-09-26"), ngn(829040, "2026-09-26"), cad(170, "2026-09-28"), ngn(163912.3, "2026-09-28")], []).map((p) => p.credit.id)).toContain(salary.id);
    const labelled = { ...ngn(829040, "2026-09-26"), category: "Family", classificationSource: "user" };
    const legs = [cad(1000, "2026-09-24"), ngn(973000, "2026-09-24"), cad(860, "2026-09-26"), labelled, cad(170, "2026-09-28"), ngn(163912.3, "2026-09-28")];
    expect(findPairs(legs, []).map((p) => p.credit.id)).not.toContain(labelled.id);
  });

  it("never pairs a send that names a different bank", () => {
    const toFirstBank = leg({ amountMinor: 50000n, transactionDate: new Date("2026-09-26T12:00:00Z"), description: "Money transfer to ADA EZE / 0123 / First Bank PLC", category: "Own transfer" });
    const legs = [cad(1000, "2026-09-24"), ngn(973000, "2026-09-24"), cad(860, "2026-09-26"), ngn(829040, "2026-09-26"), cad(170, "2026-09-28"), ngn(163912.3, "2026-09-28"), toFirstBank, ngn(485750, "2026-09-26")];
    expect(findPairs(legs, []).some((p) => p.debit.id === toFirstBank.id)).toBe(false);
  });

  it("ignores rates far from the others", () => {
    const legs = [cad(1000, "2026-09-24"), ngn(973000, "2026-09-24"), cad(860, "2026-09-26"), ngn(829040, "2026-09-26"), cad(170, "2026-09-28"), ngn(163912.3, "2026-09-28"), cad(50, "2026-09-28"), ngn(500000, "2026-09-28")];
    expect(findPairs(legs, []).some((p) => p.debit.amountMinor === 5000n)).toBe(false);
  });
});
