import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { importStatement } from "@/core/statement-import";
import { familySurnames, guessFor, personWords, sharedSurname } from "@/core/people-guess";
import { buildQuestions, MAX_PEOPLE_QUESTIONS, topUnknownPeople } from "@/core/review";

type Row = [date: string, ref: string, debit: number | null, credit: number | null, remarks: string];

function statement(rows: Row[]): Buffer {
  let balance = 5_000_000;
  const lines = rows.map(([date, ref, debit, credit, remarks]) => {
    balance += (credit ?? 0) - (debit ?? 0);
    return [date, ref, debit?.toFixed(2) ?? "", credit?.toFixed(2) ?? "", balance.toFixed(2), remarks].join(",");
  });
  return Buffer.from(["Trans. Date,Reference,Debits,Credits,Balance,Remarks", ...lines].join("\n"));
}

describe("name quirks", () => {
  it("drops rails, titles and initials so a surname can sit first or last", () => {
    expect(personWords("TRF/MRS EZE C. ADAOBI")).toEqual(["EZE", "ADAOBI"]);
    expect(personWords("NIP TO OKONKW CHIDI")).toEqual(["OKONKW", "CHIDI"]);
    expect(sharedSurname("Eze Adaobi", ["EZE"])).toBe("EZE");
    expect(sharedSurname("OKONKW CHIDI", ["OKONKWO"])).toBe("OKONKWO");
    expect(sharedSurname("Tunde Bello", ["OKONKWO"])).toBeUndefined();
  });

  it("reads the family surname from the owner's own name, last word", () => {
    expect(familySurnames("Ada Okonkwo", [], [])).toEqual(["OKONKWO"]);
  });
});

describe("guessFor", () => {
  it("same surname is family, a fixed monthly send is rent/support/staff, money both ways is a friend", () => {
    expect(guessFor({ name: "Chidi Okonkwo", inCount: 0, outCount: 2, surnames: ["OKONKWO"] })).toMatchObject({
      kind: "same_surname",
      answers: expect.arrayContaining([{ value: "rel:sibling", label: "Sibling" }]),
    });
    expect(guessFor({ name: "Amaka Obi", inCount: 0, outCount: 3, regular: { typicalMinor: 25_000_000n, day: 2, months: 3 }, surnames: [] })).toMatchObject({
      kind: "regular",
      answers: expect.arrayContaining([
        { value: "rel:vendor", label: "Rent", vendorCategory: "Housing", vendorSubcategory: "Rent" },
        { value: "rel:extended", label: "Family support" },
        { value: "rel:vendor", label: "Staff salary", vendorCategory: "Housing", vendorSubcategory: "Staff" },
      ]),
    });
    expect(guessFor({ name: "Tunde Bello", inCount: 1, outCount: 2, surnames: [] })).toMatchObject({
      kind: "two_way",
      answers: [{ value: "rel:friend", label: "Friend" }],
    });
  });
});

describe("review attaches guesses and caps unknown people", () => {
  it("puts a same-surname guess on the person question", async () => {
    const u = await db.user.create({ data: { email: "guess-surname@test.dev", name: "Ada Okonkwo" } });
    await importStatement(u.id, {
      name: "s.csv",
      bytes: statement([
        ["02-Sep-2026", "G1", 150000, null, "Instant Payment Outward 0902 TO OPAY - CHIDI OKONKWO"],
        ["03-Oct-2026", "G2", 140000, null, "NIP TRANSFER TO PALMPAY - OKONKW CHIDI"],
      ]),
    }, { institution: "GTBank" });
    const q = (await buildQuestions(u.id)).find((x) => x.person && /okonkwo|okonkw/.test(x.key))!;
    expect(q.guess).toMatchObject({ kind: "same_surname" });
    expect(q.guess!.reason).toMatch(/Okonkwo/);
  });

  it("asks at most five unknown individuals and leaves small names alone", async () => {
    const names = ["Ada Bello", "Tunde Eze", "Chinedu Okafor", "Amaka Obi", "Ngozi Ade", "Funke Lawal", "Ibrahim Musa", "Yetunde Balogun"];
    const small = "Kemi Taiwo";
    const rows: Row[] = names.flatMap((name, i) => [
      [`0${(i % 9) + 1}-Sep-2026`, `B${i}a`, 100000 + i * 1000, null, `Instant Payment Outward TO OPAY - ${name.toUpperCase()}`],
      [`0${(i % 9) + 1}-Oct-2026`, `B${i}b`, 100000 + i * 1000, null, `Instant Payment Outward TO OPAY - ${name.toUpperCase()}`],
    ]);
    rows.push(["15-Sep-2026", "S1", 3000, null, `Instant Payment Outward TO OPAY - ${small.toUpperCase()}`]);
    const u = await db.user.create({ data: { email: "guess-cap@test.dev" } });
    await importStatement(u.id, { name: "s.csv", bytes: statement(rows) }, { institution: "GTBank" });
    const qs = await buildQuestions(u.id, 20);
    const people = qs.filter((q) => q.person && q.kind === "person");
    expect(people.length).toBeLessThanOrEqual(MAX_PEOPLE_QUESTIONS);
    expect(people.every((q) => !/kemi taiwo/.test(q.key))).toBe(true);
    expect(qs.some((q) => /kemi taiwo/.test(q.key))).toBe(false);
    const top = await topUnknownPeople(u.id, 6);
    expect(top).toHaveLength(6);
    expect(top[0].person.outMinor >= top[5].person.outMinor).toBe(true);
  });

  it("a confirmed guess labels past payments the same as a hand-picked relationship", async () => {
    const u = await db.user.create({ data: { email: "guess-confirm@test.dev", name: "Ada Okonkwo" } });
    await importStatement(u.id, {
      name: "s.csv",
      bytes: statement([["02-Sep-2026", "C1", 200000, null, "Instant Payment Outward TO OPAY - CHIDI OKONKWO"]]),
    }, { institution: "GTBank" });
    const q = (await buildQuestions(u.id)).find((x) => x.guess?.kind === "same_surname")!;
    const sibling = q.guess!.answers.find((a) => a.value === "rel:sibling")!;
    const { answerQuestion } = await import("@/core/review");
    expect(await answerQuestion(u.id, "person", q.key, sibling.value)).toBe(1);
    const person = await db.person.findFirstOrThrow({ where: { userId: u.id, relationship: "sibling" } });
    expect(person.displayName.toLowerCase()).toMatch(/chidi/);
    expect(await db.transaction.count({ where: { userId: u.id, subcategory: "Siblings" } })).toBe(1);
  });
});
