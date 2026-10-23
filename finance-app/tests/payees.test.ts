import { describe, expect, it } from "vitest";
import { clusterPayees, payeeKey, payeeName, samePayee } from "@/core/payees";
import { narrationHints, purposeWords } from "@/core/review";

// Synthetic names and narrations only.
describe("payee matching across Nigerian narrations", () => {
  it("strips rails, legal forms, branches and titles from a name", () => {
    expect(payeeKey("SHOPRITE NIGERIA LTD")).toBe("shoprite");
    expect(payeeKey("Shoprite Lekki")).toBe("shoprite");
    expect(payeeKey("OPAY - CHIDI OKEKE")).toBe("chidi okeke");
    expect(payeeKey("Mr Tunde Bakare")).toBe("tunde bakare");
    expect(payeeKey("NIP TRANSFER")).toBe("nip transfer"); // nothing left: keep the words rather than lose the row
  });

  it("matches the same person however the bank wrote them", () => {
    expect(samePayee("Chidi Emeka Okeke", "OKEKE CHIDI")).toBe(true); // order and a missing middle name
    expect(samePayee("Chidi Emeka Okeke", "Okeke Chidie")).toBe(true); // "OKEKE CHIDI E" after the parser joined the initial
    expect(samePayee("CHIDI EMEKA OKEK", "Chidi Emeka Okeke")).toBe(true); // cut off by the statement
    expect(samePayee("Grace Nneka Eze", "Gracen Eze")).toBe(true);
    expect(samePayee("Mr Tunde Bakare", "TUNDE BAKARE")).toBe(true);
    expect(samePayee("OPAY - Chidi Okeke", "PALMPAY CHIDI OKEKE")).toBe(true); // the wallet is not the person
    expect(samePayee("Amaka Nneka Obi", "Obi Amaka Ifeoma")).toBe(true); // two of three names
  });

  it("matches the same shop across POS, web and transfer lines", () => {
    expect(samePayee("Shoprite", "Shoprite Nigeria Ltd")).toBe(true);
    expect(samePayee("Chicken Republic Ikeja", "CHICKENREPUBLIC")).toBe(true);
    expect(samePayee("Bolt", "Bolt Technology")).toBe(true);
  });

  it("keeps different people and short brands apart", () => {
    expect(samePayee("Grace Eze", "John Eze")).toBe(false); // a shared surname is not the same person
    expect(samePayee("Ada Eze", "Ada Okafor")).toBe(false);
    expect(samePayee("Glo", "Glory Foods")).toBe(false); // 3 letters must match exactly
    expect(samePayee("Chidi Okeke", "Chika Okeke")).toBe(false);
  });

  it("names a group after what the user taught, with their label", () => {
    const rows = ["Grace Nneka Eze", "Eze Grace", "Gracen Eze", "Shoprite", null].map((name, i) => ({ id: i, name }));
    const { clusters, unnamed } = clusterPayees(rows, (r) => r.name, [
      { pattern: "grace nneka eze", canonicalName: "Grace Nneka Eze", category: "Family", subcategory: "Mum" },
      { pattern: "nobody", canonicalName: "Skipped", category: null, subcategory: "__skipped__" },
    ]);
    expect(clusters.map((c) => [c.name, c.label, c.items.length])).toEqual([["Grace Nneka Eze", "Mum", 3], ["Shoprite", null, 1]]);
    expect(clusters[0].variants).toEqual(["Grace Nneka Eze", "Eze Grace", "Gracen Eze"]);
    expect(unnamed).toHaveLength(1);
  });

  it("matches on the person paid, else the merchant", () => {
    expect(payeeName({ counterparty: "Emeka John Obi", merchantName: "Emeka John Obi" })).toBe("Emeka John Obi");
    expect(payeeName({ counterparty: null, merchantName: "Shoprite" })).toBe("Shoprite");
    expect(payeeName({ counterparty: null, merchantName: null })).toBeNull();
  });
});

describe("purpose words in narrations", () => {
  it("reads the words typed before the recipient", () => {
    expect(purposeWords("Instant Payment Outward 000013260815 WARDROBE TO ACCESS - EMEKA JOHN OBI")).toBe("wardrobe");
    expect(purposeWords("Instant Payment Outward 000013260816 SCHOOL FEES TO GTB - ADA OKAFOR")).toBe("school fees");
    expect(purposeWords("PAYMENT / TRANSFER / TO / TUNDE BAKARE")).toBeUndefined(); // rail words are not a purpose
    expect(purposeWords("NIP TRANSFER TO PALMPAY - AMAKA NNEKA OBI")).toBeUndefined();
  });

  it("suggests a category for each distinct purpose, most common first", () => {
    const hints = narrationHints([
      "Instant Payment Outward 0001 WARDROBE TO ACCESS - EMEKA JOHN OBI",
      "Instant Payment Outward 0002 FURNITURE TO ACCESS - EMEKA JOHN OBI",
      "Instant Payment Outward 0003 WARDROBE TO ACCESS - EMEKA JOHN OBI",
      "Instant Payment Outward 0004 RENT TO ACCESS - EMEKA JOHN OBI",
    ]);
    expect(hints.map((h) => [h.words, h.category])).toEqual([["wardrobe", "Housing"], ["furniture", "Housing"], ["rent", "Housing"]]);
  });
});
