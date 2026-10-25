import { describe, expect, it } from "vitest";
import {
  Redactor, amountBucket, bucketMoneyInText, looksLikePerson, maskIdentifiers, redactNarration, roundMinor, roundMoneyInText, roundedMoney,
} from "@/core/ai/redact";

describe("identifier masking", () => {
  it.each([
    ["Instant Payment Outward 0123456789 TO OPAY", "Instant Payment Outward [ACCOUNT] TO OPAY"],
    ["BVN 22123456789 verified", "BVN [ID] verified"],
    ["call 08031234567 now", "call [PHONE] now"],
    ["call +234 803 123 4567 now", "call [PHONE] now"],
    ["call 0803-123-4567", "call [PHONE]"],
    ["uk +44 7700 900123", "uk [PHONE]"],
    ["mail ngozi.a+bank@gmail.com today", "mail [EMAIL] today"],
    ["card 4111 1111 1111 1111 used", "card [CARD] used"],
    ["card 4111111111111111 used", "card [CARD] used"],
    ["POS 539983******1234 LEKKI", "POS [CARD] LEKKI"],
    ["acct ****4521", "acct [ACCOUNT]"],
    ["session 000013260930195954000030144325", "session [NUMBER]"],
    ["ref 0903 Y", "ref 0903 Y"],
  ])("%s", (raw, masked) => {
    expect(maskIdentifiers(raw)).toBe(masked);
  });

  it("keeps the local redaction the local path has always used", () => {
    expect(redactNarration("Instant Payment Outward 000013260930195954000030144325 TO OPAY")).toBe("Instant Payment Outward # TO OPAY");
  });
});

describe("people and businesses", () => {
  it("tells people from businesses, banks and lenders", () => {
    for (const p of ["Ngozi Adebayo", "Amaka Obi", "Chidi Eze", "Mensah Abena Akosua"]) expect(looksLikePerson(p)).toBe(true);
    for (const b of ["Shoprite", "Chicken Republic", "Moniepoint MFB", "Deel Inc", "J'Stitches Couture", "Fouani Showroom", "Renmoney", "Kuda Bank", "Opay"]) {
      expect(looksLikePerson(b)).toBe(false);
    }
  });

  it("replaces the owner and people with stable placeholders, leaves businesses, and maps back", () => {
    const r = new Redactor({ owners: ["ADA OKAFOR"], people: ["Ngozi Adebayo", "Amaka Obi", "Shoprite", "Fouani Showroom"] });
    const a = r.text("Instant Payment Outward 0123456789 FROM ADA OKAFOR TO OPAY - NGOZI ADEBAYO");
    expect(a).toBe("Instant Payment Outward [ACCOUNT] FROM OWNER TO OPAY - PERSON_1");
    // Other spellings, word order and first names alone map to the same person
    expect(r.text("TO KUDA - OBI AMAKA")).toBe("TO KUDA - PERSON_2");
    expect(r.text("Amaka Obi")).toBe("PERSON_2");
    expect(r.text("How much did I send Ngozi this year?")).toBe("How much did I send PERSON_1 this year?");
    expect(r.text("Ngozi Adebayo")).toBe("PERSON_1");
    expect(r.text("POS PURCHASE SHOPRITE LEKKI and TO ZBN - FOUANI SHOWROOM")).toBe("POS PURCHASE SHOPRITE LEKKI and TO ZBN - FOUANI SHOWROOM");
    expect(r.restore("You sent PERSON_1 more than PERSON_2; OWNER saved the rest. PERSON_9 is unknown.")).toBe(
      "You sent Ngozi Adebayo more than Amaka Obi; Ada Okafor saved the rest. PERSON_9 is unknown.",
    );
    expect(r.placeholders()).toEqual({ OWNER: "Ada Okafor", PERSON_1: "Ngozi Adebayo", PERSON_2: "Amaka Obi" });
  });

  it("numbers people by first appearance, so the count of known people never leaks", () => {
    const r = new Redactor({ people: ["Ngozi Adebayo", "Amaka Obi", "Chidi Eze"] });
    expect(r.text("TO CHIDI EZE")).toBe("TO PERSON_1");
    expect(r.text("TO NGOZI ADEBAYO")).toBe("TO PERSON_2");
  });

  it("gives a shared surname its own placeholder instead of guessing who it is", () => {
    const r = new Redactor({ owners: ["Ada Okafor"], people: ["Chidi Okafor"] });
    expect(r.text("TO CHIDI OKAFOR")).toBe("TO PERSON_1");
    const lone = r.text("the Okafor family");
    expect(lone).toMatch(/^the PERSON_\d family$/);
    expect(r.restore(lone)).toBe("the Okafor family");
  });

  it("registers names met on the way (a new payee in a row)", () => {
    const r = new Redactor();
    r.add("Tunde Bakare");
    r.add("Chicken Republic");
    expect(r.text("TO TUNDE BAKARE / CHICKEN REPUBLIC")).toBe("TO PERSON_1 / CHICKEN REPUBLIC");
  });

  it("redacts every string in a tool result and restores tool inputs", () => {
    const r = new Redactor({ owners: ["Ada Okafor"], people: ["Ngozi Adebayo"] });
    const out = r.value({ name: "Ngozi Adebayo", total_sent: "₦1,983,611.00", rows: [{ description: "FROM ADA OKAFOR TO NGOZI ADEBAYO 0123456789", amount: "₦45,250.50" }], count: 3, big: 5n });
    expect(out).toEqual({ name: "PERSON_1", total_sent: "₦1,980,000", rows: [{ description: "FROM OWNER TO PERSON_1 [ACCOUNT]", amount: "₦45,300" }], count: 3, big: "5" });
    expect(r.restoreValue({ name: "PERSON_1", text: "OWNER", n: 2 })).toEqual({ name: "Ngozi Adebayo", text: "Ada Okafor", n: 2 });
  });

  it("replaces the owner's account labels with ACCOUNT_n and restores them", () => {
    const r = new Redactor({ owners: ["Ada Okafor"], accounts: ["Ada Main Salary Account", "GTB 0123456789"] });
    const out = r.text("Balance on ada main salary account and GTB 0123456789; Ada Okafor");
    expect(out).toBe("Balance on ACCOUNT_1 and ACCOUNT_2; OWNER");
    expect(r.restore("ACCOUNT_2 is lower than ACCOUNT_1")).toBe("GTB 0123456789 is lower than Ada Main Salary Account");
  });
});

describe("amounts", () => {
  it("rounds to three significant figures in whole units", () => {
    expect(roundMinor(198361100n)).toBe(198000000n);
    expect(roundMinor(4525050n)).toBe(4530000n);
    expect(roundMinor(99950n)).toBe(100000n);
    expect(roundMinor(-14500000n)).toBe(-14500000n);
    expect(roundedMoney(198361100n)).toBe("₦1,980,000");
    expect(roundedMoney(1234567n, "USD")).toBe("$12,300");
  });

  it("buckets amounts for categorization", () => {
    expect(amountBucket(9_000_000n)).toBe("₦50,000 to ₦100,000");
    expect(amountBucket(25_000_000n)).toBe("₦250,000 to ₦500,000");
    expect(amountBucket(50_000n)).toBe("under ₦1,000");
    expect(amountBucket(900_000_000n)).toBe("over ₦5,000,000");
  });

  it("rewrites formatted amounts inside text", () => {
    expect(roundMoneyInText("spent ₦145,000.00 of ₦1,983,611.00, change -₦5,432.10, $1,234.56")).toBe("spent ₦145,000 of ₦1,980,000, change -₦5,430, $1,230");
    expect(bucketMoneyInText("₦90,000.00")).toBe("₦50,000 to ₦100,000");
    expect(roundMoneyInText("on 2026-09-02, 3 payments")).toBe("on 2026-09-02, 3 payments");
  });
});
