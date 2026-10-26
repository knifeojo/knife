import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { importStatement } from "@/core/statement-import";
import { ingestTransaction } from "@/core/ledger";
import { answerQuestion, buildQuestions } from "@/core/review";
import { assessAffordability, loadAffordabilityData } from "@/core/affordability";
import { addPeopleFromText, createPerson, deletePerson, listPeople, mergePeople, undoPeopleBatch, updatePerson } from "@/core/people";

type Row = [date: string, ref: string, debit: number | null, credit: number | null, remarks: string];

function statement(rows: Row[]): Buffer {
  let balance = 2_000_000;
  const lines = rows.map(([date, ref, debit, credit, remarks]) => {
    balance += (credit ?? 0) - (debit ?? 0);
    return [date, ref, debit?.toFixed(2) ?? "", credit?.toFixed(2) ?? "", balance.toFixed(2), remarks].join(",");
  });
  return Buffer.from(["Trans. Date,Reference,Debits,Credits,Balance,Remarks", ...lines].join("\n"));
}

const ROWS: Row[] = [
  ["24-Jul-2026", "P1", null, 900000, "NIP ACME TECHNOLOGIES SALARY"],
  ["25-Jul-2026", "P2", 150000, null, "Instant Payment Outward 0725 TO OPAY - GIFT ADEBAYO OJO"],
  ["26-Jul-2026", "P3", 80000, null, "NIP TRANSFER TO PALMPAY - OJO GIFT A"],
  ["27-Jul-2026", "P4", 200000, null, "Instant Payment Outward 0727 TO OPAY - TUNDE OJO"],
  ["24-Aug-2026", "P5", null, 900000, "NIP ACME TECHNOLOGIES SALARY"],
  ["25-Aug-2026", "P6", 150000, null, "Instant Payment Outward 0825 TO OPAY - GIFT ADEBAYO OJO"],
  ["26-Aug-2026", "P7", null, 30000, "NIP TRANSFER FROM GIFT ADEBAYO OJO"],
  ["27-Aug-2026", "P8", 50000, null, "Instant Payment Outward 0827 TO OPAY - TUNDE OJO"],
  ["28-Aug-2026", "P9", 40000, null, "Instant Payment Outward 0828 TO OPAY - GIFT OBI"],
];

let n = 0;
async function setup() {
  const u = await db.user.create({ data: { email: `people${++n}@test.dev` } });
  await importStatement(u.id, { name: "s.csv", bytes: statement(ROWS) }, { institution: "GTBank" });
  return u.id;
}

const byRef = async (userId: string, refs: string[]) =>
  db.transaction.findMany({ where: { userId, reference: { in: refs } }, orderBy: { reference: "asc" } });

const future = (userId: string, id: string, type: "DEBIT" | "CREDIT", description: string) =>
  ingestTransaction(userId, {
    institution: "GTBank", source: "statement", sourceTransactionId: id, type, amountMinor: 5_000_000n, currency: "NGN",
    transactionDate: new Date("2026-09-25T10:00:00Z"), description, reference: id, accountLast4: undefined, confidence: 1,
  });

describe("Who is <NAME> to you?", () => {
  it("asks about individuals first, both directions, with samples and one-tap relationships", async () => {
    const userId = await setup();
    const qs = await buildQuestions(userId);
    const people = qs.filter((q) => q.person);
    expect(people.map((q) => q.key)).toEqual(expect.arrayContaining(["gift adebayo ojo", "tunde ojo", "gift obi"]));
    // People questions come before everything else, by the unlabelled money they fix.
    expect(qs.slice(0, people.length).every((q) => q.person)).toBe(true);
    const impacts = people.map((q) => q.impactMinor!);
    expect([...impacts].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0))).toEqual(impacts);

    const gift = people.find((q) => q.key === "gift adebayo ojo")!;
    expect(gift.title).toBe("Who is Gift Adebayo Ojo to you?");
    expect(gift.person).toMatchObject({ outCount: 3, outMinor: 38_000_000n, inCount: 1, inMinor: 3_000_000n, lastDate: "2026-08-26" });
    expect(gift.person!.variants).toEqual(expect.arrayContaining(["Gift Adebayo Ojo", "Ojo Gifta"]));
    expect(gift.examples.length).toBeGreaterThanOrEqual(2);
    expect(gift.examples.length).toBeLessThanOrEqual(3);
    const values = gift.options.map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(["rel:spouse", "rel:sibling", "rel:parent", "rel:child", "rel:extended", "rel:friend", "rel:vendor", "rel:colleague", "rel:me", "rel:other", "unknown", "not_person"]));
    expect(gift.options.find((o) => o.value === "rel:extended")).toMatchObject({ label: "Extended family (black tax)", category: "Family", subcategory: "Black tax", group: "relationship" });
    // Individuals are not asked about twice (as a payee and as a source of income).
    expect(qs.filter((q) => /gift adebayo/.test(q.key))).toHaveLength(1);
  });

  it("'Spouse' labels every payment to and from her, under each spelling, and future ones", async () => {
    const userId = await setup();
    expect(await answerQuestion(userId, "person", "gift adebayo ojo", "rel:spouse")).toBe(4);
    const rows = await byRef(userId, ["P2", "P3", "P6", "P7"]);
    const person = await db.person.findFirstOrThrow({ where: { userId }, include: { aliases: true } });
    expect(person).toMatchObject({ displayName: "Gift Adebayo Ojo", relationship: "spouse" });
    expect(person.aliases.map((a) => a.name)).toEqual(expect.arrayContaining(["Gift Adebayo Ojo", "Ojo Gifta"]));
    expect(rows.map((r) => [r.reference, r.category, r.subcategory, r.classificationSource, r.personId])).toEqual([
      ["P2", "Family", "Spouse", "user", person.id],
      ["P3", "Family", "Spouse", "user", person.id],
      ["P6", "Family", "Spouse", "user", person.id],
      ["P7", "Income", "From family & friends", "user", person.id],
    ]);
    // Gift Obi is someone else.
    expect((await byRef(userId, ["P9"]))[0].personId).toBeNull();

    const later = await future(userId, "F1", "DEBIT", "PAYMENT / TRANSFER / TO / GIFT ADEBAYO OJ");
    expect(await db.transaction.findUniqueOrThrow({ where: { id: later.transactionId } })).toMatchObject({ category: "Family", subcategory: "Spouse", personId: person.id });
    expect((await buildQuestions(userId)).some((q) => q.key === "gift adebayo ojo")).toBe(false);
  });

  it("keeps labels the owner set by hand, but links the person", async () => {
    const userId = await setup();
    const [p6] = await byRef(userId, ["P6"]);
    await db.transaction.update({ where: { id: p6.id }, data: { category: "Housing", subcategory: "Rent", classificationSource: "user", classificationConfidence: 1 } });
    await answerQuestion(userId, "person", "gift adebayo ojo", "rel:spouse");
    expect((await byRef(userId, ["P6"]))[0]).toMatchObject({ category: "Housing", subcategory: "Rent" });
    expect((await byRef(userId, ["P6"]))[0].personId).not.toBeNull();
  });

  it("Vendor takes the category the owner picks; Skip and Not a person stop the question", async () => {
    const userId = await setup();
    await answerQuestion(userId, "person", "tunde ojo", "rel:vendor", { text: "", category: "Housing", subcategory: "Home services" });
    expect((await byRef(userId, ["P4", "P8"])).map((r) => `${r.category}/${r.subcategory}`)).toEqual(["Housing/Home services", "Housing/Home services"]);
    await answerQuestion(userId, "person", "gift obi", "not_person");
    await answerQuestion(userId, "person", "gift adebayo ojo", "unknown");
    const keys = (await buildQuestions(userId)).map((q) => q.key);
    expect(keys).not.toContain("gift obi");
    expect(keys).not.toContain("gift adebayo ojo");
    expect(await db.person.count({ where: { userId } })).toBe(1);
  });

  it("legacy answers still work for individuals", async () => {
    const userId = await setup();
    expect(await answerQuestion(userId, "person", "tunde ojo", "landlord")).toBe(2);
    expect((await byRef(userId, ["P4"]))[0]).toMatchObject({ category: "Housing", subcategory: "Rent" });
  });
});

describe("Your people", () => {
  it("adds family from plain sentences and shows monthly totals", async () => {
    const userId = await setup();
    const res = await addPeopleFromText(userId, "My wife is Gift Adebayo Ojo\nMy brother is Tunde Ojo\nsomething odd");
    expect(res.unread).toEqual(["something odd"]);
    expect(res.added.map((a) => a.changed)).toEqual([4, 2]);
    expect((await byRef(userId, ["P4", "P8"])).every((r) => r.category === "Family" && r.subcategory === "Siblings")).toBe(true);

    const { people, undo } = await listPeople(userId, new Date("2026-09-10T10:00:00Z"));
    const gift = people.find((p) => p.displayName === "Gift Adebayo Ojo")!;
    expect(gift).toMatchObject({ relationship: "spouse", relationshipLabel: "Spouse / partner", note: "wife", count: 4, outMinor: 38_000_000n, inMinor: 3_000_000n, category: "Family", subcategory: "Spouse" });
    expect(gift.months.slice(0, 3)).toEqual([
      { month: "2026-09", inMinor: 0n, outMinor: 0n },
      { month: "2026-08", inMinor: 3_000_000n, outMinor: 15_000_000n },
      { month: "2026-07", inMinor: 0n, outMinor: 23_000_000n },
    ]);
    expect(people[0].displayName).toBe("Gift Adebayo Ojo"); // most money first
    expect(undo?.label).toMatch(/Tunde Ojo/);
  });

  it("changing a relationship relabels, and undo puts everything back step by step", async () => {
    const userId = await setup();
    const before = await byRef(userId, ["P4", "P8"]);
    const { personId } = await createPerson(userId, { displayName: "Tunde Ojo", relationship: "sibling" });
    await updatePerson(userId, personId, { relationship: "extended" });
    expect((await byRef(userId, ["P4", "P8"])).map((r) => r.subcategory)).toEqual(["Black tax", "Black tax"]);

    await expect(undoPeopleBatch(userId, (await db.peopleBatch.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: "asc" } })).id)).rejects.toThrow(/newer/);
    await undoPeopleBatch(userId);
    expect((await byRef(userId, ["P4", "P8"])).map((r) => r.subcategory)).toEqual(["Siblings", "Siblings"]);
    expect((await db.person.findUniqueOrThrow({ where: { id: personId } })).relationship).toBe("sibling");

    await undoPeopleBatch(userId);
    expect(await db.person.count({ where: { userId } })).toBe(0);
    const after = await byRef(userId, ["P4", "P8"]);
    expect(after.map((r) => [r.category, r.subcategory, r.classificationSource, r.personId])).toEqual(before.map((r) => [r.category, r.subcategory, r.classificationSource, null]));
    await expect(undoPeopleBatch(userId)).rejects.toThrow();
  });

  it("a relationship replaces an older Review answer for the same name, and undo brings it back", async () => {
    const userId = await setup();
    await answerQuestion(userId, "person", "tunde ojo", "friend");
    expect((await byRef(userId, ["P4"]))[0]).toMatchObject({ category: "Transfers", subcategory: "Friends", classificationSource: "user" });
    await createPerson(userId, { displayName: "Tunde Ojo", relationship: "sibling" });
    expect((await byRef(userId, ["P4", "P8"])).map((r) => r.subcategory)).toEqual(["Siblings", "Siblings"]);
    expect(await db.merchantAlias.count({ where: { userId, pattern: "tunde ojo" } })).toBe(0);
    await undoPeopleBatch(userId);
    expect(await db.merchantAlias.count({ where: { userId, pattern: "tunde ojo", category: "Transfers" } })).toBe(1);
    expect((await byRef(userId, ["P4", "P8"])).map((r) => r.subcategory)).toEqual(["Friends", "Friends"]);
  });

  it("edits aliases: a rejected spelling is unlinked and relabelled from the rules", async () => {
    const userId = await setup();
    const { personId } = await createPerson(userId, { displayName: "Gift Adebayo Ojo", relationship: "spouse" });
    await updatePerson(userId, personId, { addAliases: ["Gift Obi"] });
    expect((await byRef(userId, ["P9"]))[0]).toMatchObject({ subcategory: "Spouse", personId });
    await updatePerson(userId, personId, { rejectAliases: ["Gift Obi"] });
    const p9 = (await byRef(userId, ["P9"]))[0];
    expect(p9.personId).toBeNull();
    expect(p9.subcategory).not.toBe("Spouse");
  });

  it("merges duplicates and undoes the merge", async () => {
    const userId = await setup();
    const wife = await createPerson(userId, { displayName: "Gift Adebayo Ojo", relationship: "spouse" });
    const dup = await createPerson(userId, { displayName: "Gift Obi", relationship: "friend", note: "maiden name" });
    expect((await byRef(userId, ["P9"]))[0]).toMatchObject({ category: "Transfers", subcategory: "Gifts & lending" });
    const merged = await mergePeople(userId, wife.personId, dup.personId);
    expect(merged.changed).toBe(1);
    expect((await byRef(userId, ["P9"]))[0]).toMatchObject({ subcategory: "Spouse", personId: wife.personId });
    expect(await db.person.count({ where: { userId } })).toBe(1);
    expect((await db.personAlias.findMany({ where: { personId: wife.personId } })).map((a) => a.name)).toContain("Gift Obi");

    await undoPeopleBatch(userId);
    expect(await db.person.count({ where: { userId } })).toBe(2);
    expect((await byRef(userId, ["P9"]))[0]).toMatchObject({ subcategory: "Gifts & lending", personId: dup.personId });
    expect((await db.personAlias.findMany({ where: { personId: wife.personId } })).map((a) => a.name)).not.toContain("Gift Obi");
  });

  it("removing a person puts relationship labels back to the rules", async () => {
    const userId = await setup();
    const { personId } = await createPerson(userId, { displayName: "Tunde Ojo", relationship: "sibling" });
    await deletePerson(userId, personId);
    expect((await byRef(userId, ["P4"]))[0]).toMatchObject({ category: "Transfers", personId: null });
    await undoPeopleBatch(userId);
    expect((await byRef(userId, ["P4"]))[0]).toMatchObject({ subcategory: "Siblings", personId });
  });
});

describe("Afford", () => {
  it("shows family support as an obligation, never as a cut", async () => {
    const userId = await setup();
    await addPeopleFromText(userId, "My wife is Gift Adebayo Ojo\nMy brother is Tunde Ojo");
    const now = new Date("2026-09-10T10:00:00Z");
    const r = assessAffordability(await loadAffordabilityData(userId, now), { amountMinor: 300_000_000n, horizon: { kind: "month_end" } }, now);
    expect(r.inputs.familyObligations).toEqual([
      { label: "Spouse", monthlyMinor: 19_000_000n, months: 2, recurring: true },
      { label: "Siblings", monthlyMinor: 12_500_000n, months: 2, recurring: false },
      { label: "Gifts", monthlyMinor: 2_000_000n, months: 1, recurring: false },
    ]);
    expect(r.advice.filter((a) => a.kind === "cut").map((a) => a.subject)).not.toContain("Family");
    expect(r.advice.map((a) => a.text).join(" ")).not.toMatch(/spouse|sibling|black tax|family/i);
  });
});

describe("ambiguous names go to Review", () => {
  it("asks 'Which of your people is …?' instead of guessing, and remembers the answer", async () => {
    const userId = await setup();
    const a = await createPerson(userId, { displayName: "Tunde Adewale Ojo", relationship: "sibling" });
    await createPerson(userId, { displayName: "Tunde Bello Ojo", relationship: "friend" });
    expect((await byRef(userId, ["P4", "P8"])).every((r) => r.personId === null && r.category !== "Family")).toBe(true);

    const q = (await buildQuestions(userId)).find((x) => x.kind === "match")!;
    expect(q.key).toBe("tunde ojo");
    expect(q.title).toBe("Which of your people is Tunde Ojo?");
    expect(q.options.map((o) => o.value)).toEqual(expect.arrayContaining([`person:${a.personId}`, "no", "unknown"]));
    expect((await buildQuestions(userId)).some((x) => x.kind === "person" && x.key === "tunde ojo")).toBe(false);

    expect(await answerQuestion(userId, "match", q.key, `person:${a.personId}`)).toBe(2);
    expect((await byRef(userId, ["P4", "P8"])).every((r) => r.subcategory === "Siblings" && r.personId === a.personId)).toBe(true);
    expect((await buildQuestions(userId)).some((x) => x.key === "tunde ojo")).toBe(false);
  });

  it("'No, someone else' turns it into a Who question", async () => {
    const userId = await setup();
    await createPerson(userId, { displayName: "Tunde Adewale Ojo", relationship: "sibling" });
    await createPerson(userId, { displayName: "Tunde Bello Ojo", relationship: "friend" });
    await answerQuestion(userId, "match", "tunde ojo", "no");
    const qs = await buildQuestions(userId);
    expect(qs.some((x) => x.kind === "match")).toBe(false);
    expect(qs.find((x) => x.key === "tunde ojo")).toMatchObject({ kind: "person", title: "Who is Tunde Ojo to you?" });
  });
});
