import { describe, expect, it } from "vitest";
import { categorize, type UserRule } from "@/core/categorize";
import {
  AUTO_MATCH,
  REVIEW_MATCH,
  aliasKey,
  mappingFor,
  matchPeople,
  nameScore,
  parsePeopleText,
  relationshipForLabel,
  type KnownPerson,
} from "@/core/people-match";

const person = (id: string, displayName: string, relationship: string, aliases: string[] = [], extra: Partial<KnownPerson> = {}): KnownPerson => ({
  id, displayName, relationship, aliases: [displayName, ...aliases].map((name) => ({ name, key: aliasKey(name) })), ...extra,
});

const GIFT = person("gift", "Gift Adebayo Ojo", "spouse");
const TUNDE = person("tunde", "Tunde Ojo", "sibling");

describe("fuzzy name matching", () => {
  it.each([
    ["GIFT ADEBAYO OJO", "same words"],
    ["OJO GIFT ADEBAYO", "reordered"],
    ["ADEBAYO OJO GIFT", "reordered"],
    ["OJO GIFT A", "reordered, middle name as an initial"],
    ["Ojo Gifta", "initial glued on by narration cleanup"],
    ["GIFT A OJO", "middle initial"],
    ["GIFT ADEBAYO OJ", "surname cut off"],
    ["GIFT ADEBA OJO", "middle name cut off"],
    ["MRS GIFT ADEBAYO OJO", "title"],
    ["Gift Adebayo-Ojo", "hyphen and case"],
  ])("%s is Gift Adebayo Ojo (%s)", (name) => {
    expect(nameScore(name, "Gift Adebayo Ojo")).toBeGreaterThanOrEqual(AUTO_MATCH);
    expect(matchPeople(name, [GIFT, TUNDE])).toMatchObject({ status: "match", personId: "gift" });
  });

  it("one name word alone is never enough: TRF TO GIFT goes to Review", () => {
    const score = nameScore("TRF TO GIFT", "Gift Adebayo Ojo");
    expect(score).toBeGreaterThanOrEqual(REVIEW_MATCH);
    expect(score).toBeLessThan(AUTO_MATCH);
    expect(matchPeople("TRF TO GIFT", [GIFT])).toMatchObject({ status: "ambiguous" });
  });

  it("a shared surname is a different person", () => {
    expect(nameScore("TUNDE OJO", "Gift Adebayo Ojo")).toBeLessThan(REVIEW_MATCH);
    expect(matchPeople("TUNDE OJO", [GIFT, TUNDE])).toMatchObject({ status: "match", personId: "tunde" });
    expect(matchPeople("GIFT OKAFOR", [GIFT])).toMatchObject({ status: "none" });
    expect(matchPeople("BABATUNDE OLUMIDE EZE", [person("x", "Oluwaseun Samuel Eze", "sibling")]).status).toBe("none");
  });

  it("a cut-off saved spelling still matches the full name, for less", () => {
    const short = person("c", "Chukwuemek Obi", "friend");
    const s = nameScore("CHUKWUEMEKA OBI", "Chukwuemek Obi");
    expect(s).toBeGreaterThanOrEqual(REVIEW_MATCH);
    expect(s).toBeLessThan(1);
    expect(matchPeople("CHUKWUEMEKA OBI", [short]).status).not.toBe("none");
  });

  it("two people close to one name is ambiguous, never applied", () => {
    const a = person("a", "Tunde Adewale Ojo", "sibling");
    const b = person("b", "Tunde Bello Ojo", "friend");
    const m = matchPeople("TUNDE OJO", [a, b]);
    expect(m.status).toBe("ambiguous");
    expect(m.personId).toBeUndefined();
    expect(m.candidates.map((c) => c.personId).sort()).toEqual(["a", "b"]);
  });

  it("a saved spelling matches exactly, and a rejected one never matches", () => {
    const g = { ...GIFT, aliases: [...GIFT.aliases, { name: "OJO G", key: aliasKey("OJO G") }, { name: "GIFT ADEBAYO OJO", key: aliasKey("GIFT OJO ADEBAYO"), rejected: true }] };
    expect(matchPeople("G OJO", [g])).toMatchObject({ status: "match", confidence: 1 });
    expect(matchPeople("OJO ADEBAYO GIFT", [g]).status).toBe("none");
  });
});

describe("relationship to category", () => {
  it.each([
    ["spouse", "DEBIT", "Family", "Spouse"],
    ["sibling", "DEBIT", "Family", "Siblings"],
    ["parent", "DEBIT", "Family", "Parents"],
    ["child", "DEBIT", "Family", "Children"],
    ["extended", "DEBIT", "Family", "Black tax"],
    ["friend", "DEBIT", "Transfers", "Gifts & lending"],
    ["vendor", "DEBIT", "Shopping", "Vendors"],
    ["me", "DEBIT", "Own transfer", "Between own accounts"],
    ["me", "CREDIT", "Own transfer", "Between own accounts"],
    ["spouse", "CREDIT", "Income", "From family & friends"],
    ["extended", "CREDIT", "Income", "From family & friends"],
  ])("%s, money %s -> %s / %s", (rel, type, category, subcategory) => {
    expect(mappingFor(rel, type)).toEqual({ category, subcategory });
  });

  it("vendors take the category the owner picked; unknown directions keep their label", () => {
    expect(mappingFor("vendor", "DEBIT", { category: "Housing", subcategory: "Home services" })).toEqual({ category: "Housing", subcategory: "Home services" });
    expect(mappingFor("vendor", "CREDIT")).toBeNull();
    expect(mappingFor("other", "DEBIT")).toBeNull();
    expect(mappingFor("nonsense", "DEBIT")).toBeNull();
  });

  it("reads the relationship an AI label proposes", () => {
    expect(relationshipForLabel("Family", "Spouse")).toBe("spouse");
    expect(relationshipForLabel("Family", "Black tax")).toBe("extended");
    expect(relationshipForLabel("Shopping", "Clothing")).toBeUndefined();
  });
});

describe("categorize with known people", () => {
  const rules: UserRule[] = [GIFT, TUNDE].map((p) => ({ pattern: `person:${p.id}`, canonicalName: p.displayName, category: null, subcategory: null, person: p }));

  it("labels a payment to the wife as Family / Spouse, ahead of the AI, under any spelling", () => {
    for (const d of ["Instant Payment Outward 0901 TO OPAY - GIFT ADEBAYO OJO", "NIP TRANSFER TO PALMPAY - OJO GIFT A"]) {
      expect(categorize({ description: d, type: "DEBIT" }, rules)).toMatchObject({ category: "Family", subcategory: "Spouse", source: "user", personId: "gift" });
    }
    expect(categorize({ description: "NIP TRANSFER TO PALMPAY - TUNDE OJO", type: "DEBIT" }, rules)).toMatchObject({ category: "Family", subcategory: "Siblings", personId: "tunde" });
  });

  it("does not apply a weak match", () => {
    const c = categorize({ description: "NIP TRANSFER TO PALMPAY - GIFT", type: "DEBIT" }, rules);
    expect(c.personId).toBeUndefined();
    expect(c.subcategory).not.toBe("Spouse");
  });

  it("money from family is income from family, and fees stay fees", () => {
    expect(categorize({ description: "NIP TRANSFER FROM GIFT ADEBAYO OJO", type: "CREDIT" }, rules)).toMatchObject({ category: "Income", subcategory: "From family & friends" });
  });

  it("a confirmed person beats the MTN airtime merchant rule on a Ghana MoMo payout", () => {
    const d = "Money transfer to GIFT ADEBAYO OJO / +233201234567 / MTN";
    expect(categorize({ description: d, type: "DEBIT" })).toMatchObject({ category: "Transfers", destinationCountry: "Ghana" });
    expect(categorize({ description: d, type: "DEBIT" }, rules)).toMatchObject({
      category: "Family", subcategory: "Spouse", source: "user", personId: "gift",
    });
  });
});

describe("'My wife is …'", () => {
  it("reads relationships from plain sentences", () => {
    const { people, unread } = parsePeopleText("My wife is Gift Adebayo Ojo\nmy brother: Tunde Ojo\nNgozi Okafor is my aunty\nOur driver is Musa Bello\nhello there");
    expect(people).toEqual([
      { name: "Gift Adebayo Ojo", relationship: "spouse", word: "wife" },
      { name: "Tunde Ojo", relationship: "sibling", word: "brother" },
      { name: "Ngozi Okafor", relationship: "extended", word: "aunty" },
      { name: "Musa Bello", relationship: "vendor", word: "driver", vendor: { category: "Housing", subcategory: "Home services" } },
    ]);
    expect(unread).toEqual(["hello there"]);
  });
});
