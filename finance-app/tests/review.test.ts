import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { importStatement } from "@/core/statement-import";
import { ingestTransaction } from "@/core/ledger";
import { answerQuestion, askAgain, buildQuestions, inferFromText, memoOf } from "@/core/review";
import { nameHint, sameName } from "@/core/categorize";
import { spendingByCategory, specificMonth } from "@/core/analytics";

const STATEMENT = Buffer.from([
  "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
  "01-Sep-2026,R1,,1500000.00,1600000.00,W5WM-MONIE MFB-DEEL INC",
  "02-Sep-2026,R2,300000.00,,1300000.00,Instant Payment Outward 0901 JULY BAL FROM EZE ADA BELLO TO OPAY - MENSAH ABENA AKOSUA",
  "03-Sep-2026,R3,120000.00,,1180000.00,Instant Payment Outward 0902 JUNE FROM EZE ADA BELLO TO ZBN - ABENA MENSAH",
  "04-Sep-2026,R4,130000.00,,1050000.00,Instant Payment Outward 0903 AGBADA FROM EZE ADA BELLO TO OPAY - J'STITCHES COUTURE",
  "05-Sep-2026,R5,250000.00,,800000.00,Instant Payment Outward 0904 MONTHLY TO",
  "06-Sep-2026,R6,250000.00,,550000.00,Instant Payment Outward 0905 MONTHLY TO",
  "07-Sep-2026,R7,50000.00,,500000.00,Instant Payment Outward 0906 X FROM EZE ADA BELLO TO WEMA - EZE ADA BELLO",
].join("\n"));

describe("name helpers", () => {
  it("treats the same words in any order as one person", () => {
    expect(sameName("Mensah Abena Akosua", "Abena Mensah")).toBe(true);
    expect(sameName("Mensah Abena", "Mensah Ada")).toBe(false);
    expect(sameName("Ada", "Ada Obi")).toBe(false);
    // Two of three names: same person
    expect(sameName("Mensah Abena Akosua", "Abena Akosua Ama")).toBe(true);
    // Shared surname only: different people (dad, brother, you)
    expect(sameName("Babatunde Olumide Eze", "Oluwaseun Samuel Eze")).toBe(false);
    expect(sameName("Oluwatobi Daniel Eze", "Oluwaseun Samuel Eze")).toBe(false);
  });

  it("reads what a business does from its name", () => {
    expect(nameHint("J'Stitches Couture")?.label).toBe("Tailor or clothing");
    expect(nameHint("Ekanaturals Limited")?.label).toBe("Hair or beauty");
    expect(nameHint("Ebubechukwuinterior")?.label).toBe("Interior or furniture");
    expect(nameHint("Fouani Surulere Showroom")?.label).toBe("Electronics store");
    expect(nameHint("Live Lounge Limited")?.label).toBe("Food or drinks place");
    expect(nameHint("Acme Ventures Ltd")?.label).toBe("A business");
    expect(nameHint("Mensah Abena Akosua")).toBeUndefined();
  });

  it("extracts the memo typed before TO", () => {
    expect(memoOf("Instant Payment Outward 090405260903 MONTHLY TO")).toBe("monthly");
  });
});

describe("review questions", () => {
  it("asks the right questions, groups name variants, and answers apply to past and future rows", async () => {
    const u = await db.user.create({ data: { email: "review@test.dev" } });
    await importStatement(u.id, { name: "s.csv", bytes: STATEMENT }, { institution: "GTBank" });

    // Own account transfer detected automatically from the inferred holder
    const own = await db.transaction.findFirstOrThrow({ where: { userId: u.id, reference: "R7" } });
    expect(own.category).toBe("Own transfer");

    const qs = await buildQuestions(u.id);
    const kinds = qs.map((q) => `${q.kind}:${q.key}`);
    expect(qs[0]).toMatchObject({ kind: "holder", key: "eze ada bello" });
    expect(kinds).toContain("income:deel inc");
    expect(kinds).toContain("memo:monthly");
    const person = qs.filter((q) => q.kind === "person" && /mensah/.test(q.key));
    expect(person).toHaveLength(1); // two spellings, one question
    expect(person[0]).toMatchObject({ count: 2, totalMinor: 42_000_000n, hint: "The name looks like a person" });
    const tailor = qs.find((q) => q.key.includes("stitches"))!;
    expect(tailor.options[0]).toMatchObject({ value: "hint", category: "Shopping", subcategory: "Clothing" });

    // "Yes, that's me" must not turn spending FROM me into own transfers
    await answerQuestion(u.id, "holder", "eze ada bello", "yes");
    const rent = await db.transaction.findFirstOrThrow({ where: { userId: u.id, reference: "R2" } });
    expect(rent.category).not.toBe("Own transfer");

    // Landlord answer covers both spellings now...
    expect(await answerQuestion(u.id, "person", person[0].key, "landlord")).toBe(2);
    const both = await db.transaction.findMany({ where: { userId: u.id, reference: { in: ["R2", "R3"] } } });
    expect(both.every((t) => t.category === "Housing" && t.classificationSource === "user")).toBe(true);

    // ...and future payments to that person
    const later = await ingestTransaction(u.id, {
      institution: "GTBank", source: "statement", sourceTransactionId: "later-1", type: "DEBIT", amountMinor: 100_000n, currency: "NGN",
      transactionDate: new Date("2026-10-02T10:00:00Z"), description: "Instant Payment Outward 0999 OCT TO OPAY - ABENA MENSAH AKOSUA",
      reference: "R99", accountLast4: undefined, confidence: 1,
    });
    expect((await db.transaction.findUniqueOrThrow({ where: { id: later.transactionId } })).category).toBe("Housing");

    // Memo answer labels the nameless transfers; income answer labels Deel
    expect(await answerQuestion(u.id, "memo", "monthly", "family")).toBe(2);
    await answerQuestion(u.id, "income", "deel inc", "salary");
    expect((await db.transaction.findFirstOrThrow({ where: { userId: u.id, reference: "R1" } })).subcategory).toBe("Salary");

    // Answered questions disappear
    const after = (await buildQuestions(u.id)).map((q) => q.key);
    expect(after).not.toContain("monthly");
    expect(after).not.toContain("deel inc");
    expect(after.some((k) => /mensah/.test(k))).toBe(false);
  });
});

describe("the Car answer", () => {
  const MECHANIC = Buffer.from([
    "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
    "01-Sep-2026,C1,,500000.00,500000.00,NIP ACME TECHNOLOGIES SALARY",
    "05-Sep-2026,C2,45000.00,,455000.00,Instant Payment Outward 0905 TO OPAY - TUNDE ADEWALE BALOGUN",
    "19-Sep-2026,C3,80000.00,,375000.00,NIP TRANSFER TO PALMPAY - BALOGUN TUNDE",
  ].join("\n"));

  it("labels a mechanic or car vendor as Transport / Car, learns the name, and counts it in Transport spend", async () => {
    const u = await db.user.create({ data: { email: "car@test.dev" } });
    await importStatement(u.id, { name: "s.csv", bytes: MECHANIC }, { institution: "GTBank" });
    const q = (await buildQuestions(u.id)).find((x) => x.kind === "person" && /tunde/.test(x.key))!;
    expect(q.options).toContainEqual(expect.objectContaining({ value: "car", category: "Transport", subcategory: "Car" }));

    expect(await answerQuestion(u.id, "person", q.key, "car")).toBe(2);
    const rows = await db.transaction.findMany({ where: { userId: u.id, reference: { in: ["C2", "C3"] } } });
    expect(rows.every((r) => r.category === "Transport" && r.subcategory === "Car" && r.classificationSource === "user")).toBe(true);
    const alias = await db.merchantAlias.findFirstOrThrow({ where: { userId: u.id, category: "Transport" } });
    expect(alias.subcategory).toBe("Car");

    const later = await ingestTransaction(u.id, {
      institution: "GTBank", source: "statement", sourceTransactionId: "car-later", type: "DEBIT", amountMinor: 3_000_000n, currency: "NGN",
      transactionDate: new Date("2026-10-03T10:00:00Z"), description: "Instant Payment Outward 1003 TO OPAY - TUNDE ADEWALE BALOGUN",
      reference: "C4", accountLast4: undefined, confidence: 1,
    });
    expect(await db.transaction.findUniqueOrThrow({ where: { id: later.transactionId } })).toMatchObject({ category: "Transport", subcategory: "Car" });

    const transport = (await spendingByCategory(u.id, specificMonth(2026, 8))).find((c) => c.category === "Transport");
    expect(transport).toMatchObject({ total: 12_500_000n, count: 2 });
    expect((await buildQuestions(u.id)).some((x) => /tunde/.test(x.key))).toBe(false);
  });
});

describe("free-text 'Other' answers", () => {
  it.each([
    ["person", "my landlady", "Housing"],
    ["person", "My sister Bimpe", "Family"],
    ["person", "our driver", "Housing"],
    ["person", "J's tailor for agbada", "Shopping"],
    ["person", "car loan repayment", "Debt"],
    ["person", "piggyvest savings", "Own transfer"],
    ["person", "something random", "Other"],
    ["person", "Resturant", "Food"],
    ["person", "resturent for small chops", "Food"],
    ["person", "I funded my pesapeer wallet", "Own transfer"],
    ["income", "rent from my tenant", "Income"],
    ["income", "from my other account", "Own transfer"],
  ] as const)("%s: %s -> %s", (kind, text, category) => {
    expect(inferFromText(kind, text).category).toBe(category);
  });

  it("keeps the user's words as the label and respects an explicit category", () => {
    expect(inferFromText("person", "  my landlady ")).toEqual({ category: "Housing", subcategory: "My landlady" });
    expect(inferFromText("person", "Chidi", "Business")).toEqual({ category: "Business", subcategory: "Chidi" });
  });

  it("applies a typed answer to every payment with that name", async () => {
    const u = await db.user.create({ data: { email: "other@test.dev" } });
    await importStatement(u.id, { name: "s.csv", bytes: STATEMENT }, { institution: "GTBank" });
    const n = await answerQuestion(u.id, "person", "mensah abena akosua", "other", { text: "my landlady" });
    expect(n).toBe(2);
    const rows = await db.transaction.findMany({ where: { userId: u.id, reference: { in: ["R2", "R3"] } } });
    expect(rows.every((r) => r.category === "Housing" && r.subcategory === "My landlady")).toBe(true);
  });
});

describe("can't remember", () => {
  it("stops asking, changes nothing, and can be asked again", async () => {
    const u = await db.user.create({ data: { email: "skip@test.dev" } });
    await importStatement(u.id, { name: "s.csv", bytes: STATEMENT }, { institution: "GTBank" });
    const before = await db.transaction.findMany({ where: { userId: u.id }, orderBy: { id: "asc" } });
    expect(await answerQuestion(u.id, "memo", "monthly", "unknown")).toBe(0);
    const after = await db.transaction.findMany({ where: { userId: u.id }, orderBy: { id: "asc" } });
    expect(after.map((t) => t.category)).toEqual(before.map((t) => t.category));
    expect((await buildQuestions(u.id)).map((q) => q.key)).not.toContain("monthly");
    await askAgain(u.id, "monthly");
    expect((await buildQuestions(u.id)).map((q) => q.key)).toContain("monthly");
  });
});

describe("pattern learning", () => {
  it("spots a regular monthly payment and says so in the question", async () => {
    const { regularPattern } = await import("@/core/review");
    const d = (s: string) => new Date(`${s}T10:00:00Z`);
    expect(regularPattern([{ minor: 15_000_000n, date: d("2026-08-03") }, { minor: 15_000_000n, date: d("2026-09-04") }])).toMatchObject({ typicalMinor: 15_000_000n, months: 2 });
    expect(regularPattern([{ minor: 15_000_000n, date: d("2026-09-03") }, { minor: 15_000_000n, date: d("2026-09-20") }])).toBeUndefined(); // one month
    expect(regularPattern([{ minor: 1_000_000n, date: d("2026-08-03") }, { minor: 9_000_000n, date: d("2026-09-03") }])).toBeUndefined(); // amounts differ

    const u = await db.user.create({ data: { email: "regular@test.dev" } });
    const csv = Buffer.from(["Trans. Date,Reference,Debits,Credits,Balance,Remarks",
      "03-Aug-2026,Q1,150000.00,,850000.00,Instant Payment Outward 01 AUG TO OPAY - SUNDAY OKON",
      "04-Sep-2026,Q2,150000.00,,700000.00,Instant Payment Outward 02 SEP TO OPAY - SUNDAY OKON"].join("\n"));
    await importStatement(u.id, { name: "s.csv", bytes: csv }, { institution: "GTBank" });
    const q = (await buildQuestions(u.id)).find((x) => x.key === "sunday okon")!;
    expect(q.prompt).toMatch(/about ₦150,000\.00 around the 3rd|about ₦150,000\.00 around the 4th/);
  });
});
