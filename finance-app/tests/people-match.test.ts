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

const AMAKA = person("amaka", "Amaka Chinwe Okeke", "spouse");
const TUNDE = person("tunde", "Tunde Okeke", "sibling");

describe("fuzzy name matching", () => {
  it.each([
    ["AMAKA CHINWE OKEKE", "same words"],
    ["OKEKE AMAKA CHINWE", "reordered"],
    ["CHINWE OKEKE AMAKA", "reordered"],
    ["OKEKE AMAKA C", "reordered, middle name as an initial"],
    ["Okeke Amakac", "initial glued on by narration cleanup"],
    ["AMAKA C OKEKE", "middle initial"],
    ["AMAKA CHINWE OKEK", "surname cut off"],
    ["AMAKA CHIN OKEKE", "middle name cut off"],
    ["MRS AMAKA CHINWE OKEKE", "title"],
    ["Amaka Chinwe-Okeke", "hyphen and case"],
  ])("%s is Amaka Chinwe Okeke (%s)", (name) => {
    expect(nameScore(name, "Amaka Chinwe Okeke")).toBeGreaterThanOrEqual(AUTO_MATCH);
    expect(matchPeople(name, [AMAKA, TUNDE])).toMatchObject({ status: "match", personId: "amaka" });
  });

  it("one name word alone is never enough: TRF TO AMAKA goes to Review", () => {
    const score = nameScore("TRF TO AMAKA", "Amaka Chinwe Okeke");
    expect(score).toBeGreaterThanOrEqual(REVIEW_MATCH);
    expect(score).toBeLessThan(AUTO_MATCH);
    expect(matchPeople("TRF TO AMAKA", [AMAKA])).toMatchObject({ status: "ambiguous" });
  });

  it("a shared surname is a different person", () => {
    expect(nameScore("TUNDE OKEKE", "Amaka Chinwe Okeke")).toBeLessThan(REVIEW_MATCH);
    expect(matchPeople("TUNDE OKEKE", [AMAKA, TUNDE])).toMatchObject({ status: "match", personId: "tunde" });
    expect(matchPeople("GIFT OKAFOR", [AMAKA])).toMatchObject({ status: "none" });
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
    const a = person("a", "Tunde Adewale Okeke", "sibling");
    const b = person("b", "Tunde Bello Okeke", "friend");
    const m = matchPeople("TUNDE OKEKE", [a, b]);
    expect(m.status).toBe("ambiguous");
    expect(m.personId).toBeUndefined();
    expect(m.candidates.map((c) => c.personId).sort()).toEqual(["a", "b"]);
  });

  it("a saved spelling matches exactly, and a rejected one never matches", () => {
    const g = { ...AMAKA, aliases: [...AMAKA.aliases, { name: "OKEKE A", key: aliasKey("OKEKE A") }, { name: "AMAKA CHINWE OKEKE", key: aliasKey("AMAKA OKEKE CHINWE"), rejected: true }] };
    expect(matchPeople("A OKEKE", [g])).toMatchObject({ status: "match", confidence: 1 });
    expect(matchPeople("OKEKE CHINWE AMAKA", [g]).status).toBe("none");
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
  const rules: UserRule[] = [AMAKA, TUNDE].map((p) => ({ pattern: `person:${p.id}`, canonicalName: p.displayName, category: null, subcategory: null, person: p }));

  it("labels a payment to the wife as Family / Spouse, ahead of the AI, under any spelling", () => {
    for (const d of ["Instant Payment Outward 0901 TO OPAY - AMAKA CHINWE OKEKE", "NIP TRANSFER TO PALMPAY - OKEKE AMAKA C"]) {
      expect(categorize({ description: d, type: "DEBIT" }, rules)).toMatchObject({ category: "Family", subcategory: "Spouse", source: "user", personId: "amaka" });
    }
    expect(categorize({ description: "NIP TRANSFER TO PALMPAY - TUNDE OKEKE", type: "DEBIT" }, rules)).toMatchObject({ category: "Family", subcategory: "Siblings", personId: "tunde" });
  });

  it("does not apply a weak match", () => {
    const c = categorize({ description: "NIP TRANSFER TO PALMPAY - AMAKA", type: "DEBIT" }, rules);
    expect(c.personId).toBeUndefined();
    expect(c.subcategory).not.toBe("Spouse");
  });

  it("money from family is income from family, and fees stay fees", () => {
    expect(categorize({ description: "NIP TRANSFER FROM AMAKA CHINWE OKEKE", type: "CREDIT" }, rules)).toMatchObject({ category: "Income", subcategory: "From family & friends" });
  });

  it("a confirmed person beats the MTN airtime merchant rule on a Ghana MoMo payout", () => {
    const d = "Money transfer to AMAKA CHINWE OKEKE / +233201234567 / MTN";
    const bare = categorize({ description: d, type: "DEBIT" });
    expect(bare.subcategory).not.toBe("Airtime & data");
    expect(bare).toMatchObject({ destinationCountry: "Ghana" });
    expect(categorize({ description: d, type: "DEBIT" }, rules)).toMatchObject({
      category: "Family", subcategory: "Spouse", source: "user", personId: "amaka",
    });
  });
});

describe("'My wife is …'", () => {
  it("reads relationships from plain sentences", () => {
    const { people, unread } = parsePeopleText("My wife is Amaka Chinwe Okeke\nmy brother: Tunde Okeke\nNgozi Okafor is my aunty\nOur driver is Musa Bello\nhello there");
    expect(people).toEqual([
      { name: "Amaka Chinwe Okeke", relationship: "spouse", word: "wife" },
      { name: "Tunde Okeke", relationship: "sibling", word: "brother" },
      { name: "Ngozi Okafor", relationship: "extended", word: "aunty" },
      { name: "Musa Bello", relationship: "vendor", word: "driver", vendor: { category: "Housing", subcategory: "Home services" } },
    ]);
    expect(unread).toEqual(["hello there"]);
  });
});
