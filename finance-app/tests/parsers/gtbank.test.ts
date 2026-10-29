import { describe, expect, it } from "vitest";
import { GTBANK_FIXTURES as F, GTBANK_REGRESSION as R } from "@/core/fixtures/gtbank-alerts";
import { extractMaskedLast4 } from "@/core/alerts/money";
import { GTBankParser } from "@/core/parsers/gtbank";
import { parseEmail } from "@/core/parsers";
import { htmlToText, parseBankDate } from "@/core/parsers/text";
import { parseAmountToMinor } from "@/lib/money";

const parser = new GTBankParser();

describe("GTBankParser: GeNS HTML layout", () => {
  it("parses a debit transfer", () => {
    const tx = parser.parse(F.gensDebitTransfer)!;
    expect(tx).not.toBeNull();
    expect(tx.type).toBe("DEBIT");
    expect(tx.amountMinor).toBe(25_000_000n);
    expect(tx.currency).toBe("NGN");
    expect(tx.balanceAfterMinor).toBe(450_000_000n);
    expect(tx.reference).toBe("000013260925101452001");
    expect(tx.accountLast4).toBe("4521");
    expect(tx.description).toContain("OLUWASEUN ADEYEMI");
    // 10:14:52 Lagos = 09:14:52 UTC
    expect(tx.transactionDate.toISOString()).toBe("2026-09-25T09:14:52.000Z");
    expect(tx.confidence).toBe(1);
  });

  it("parses a salary credit", () => {
    const tx = parser.parse(F.gensCreditSalary)!;
    expect(tx.type).toBe("CREDIT");
    expect(tx.amountMinor).toBe(198_361_100n);
    expect(tx.description).toContain("SALARY");
  });

  it("keeps kobo on decimal amounts", () => {
    expect(parser.parse(F.gensPosShoprite)!.amountMinor).toBe(4_525_050n);
  });

  it("parses small fee debits", () => {
    const tx = parser.parse(F.gensSmsFee)!;
    expect(tx.type).toBe("DEBIT");
    expect(tx.amountMinor).toBe(2_400n);
  });

  it("parses non-NGN domiciliary alerts with ISO dates", () => {
    const tx = parser.parse(F.usdCredit)!;
    expect(tx.currency).toBe("USD");
    expect(tx.amountMinor).toBe(120_000n);
    expect(tx.accountLast4).toBe("9901");
    expect(tx.transactionDate.toISOString()).toBe("2026-09-10T10:00:00.000Z");
  });
});

describe("GTBankParser: plaintext prose layout", () => {
  it("parses 'your account has been debited with'", () => {
    const tx = parser.parse(F.proseDebit)!;
    expect(tx).toMatchObject({ type: "DEBIT", amountMinor: 8_500_000n, currency: "NGN", reference: "ABC123" });
    expect(tx.balanceAfterMinor).toBe(276_638_900n);
    expect(tx.description).toBe("POS/BOLT TECHNOLOGY OU/LAGOS NG");
    // dd/mm/yyyy: 22 September, not month 22
    expect(tx.transactionDate.toISOString().slice(0, 10)).toBe("2026-09-22");
  });

  it("parses 'your account has been credited with'", () => {
    const tx = parser.parse(F.proseCreditPesa)!;
    expect(tx).toMatchObject({ type: "CREDIT", amountMinor: 66_680_000n, reference: "PSA7781204" });
  });

  it("handles missing optional fields with lower confidence and email date fallback", () => {
    const tx = parser.parse(F.missingOptionalFields)!;
    expect(tx.type).toBe("DEBIT");
    expect(tx.amountMinor).toBe(500_000n);
    expect(tx.reference).toBeUndefined();
    expect(tx.balanceAfterMinor).toBeUndefined();
    expect(tx.transactionDate).toEqual(F.missingOptionalFields.date);
    expect(tx.confidence).toBeLessThan(0.7);
  });
});

describe("GTBankParser: recognition and failure", () => {
  it("does not claim other banks' alerts", () => {
    expect(parser.canParse(F.otherBank)).toBe(false);
    expect(parseEmail(F.otherBank).status).toBe("skipped");
  });

  it("returns failed, not a guessed transaction, for malformed alerts", () => {
    expect(parseEmail(F.malformedAlert).status).toBe("failed");
  });

  it("does not create transactions from marketing email", () => {
    expect(parseEmail(F.marketing).status).toBe("skipped");
  });

  it("refuses to guess direction when neither debit nor credit is stated", () => {
    const tx = parser.parse({
      id: "x",
      from: "gens@gtbank.com",
      subject: "GeNS Transaction Alert",
      date: new Date(),
      text: "Guaranty Trust Bank GeNS\nAmount : NGN 1,000.00\nDescription : SOMETHING",
    });
    expect(tx).toBeNull();
  });

  it("recognises every GTBank transaction fixture", () => {
    const ok = [F.gensDebitTransfer, F.gensCreditSalary, F.proseDebit, F.proseCreditPesa, F.gensPosShoprite, F.gensNetflix, F.gensSmsFee, F.missingOptionalFields, F.usdCredit];
    for (const e of ok) expect(parseEmail(e).status, e.id).toBe("parsed");
  });
});

describe("GTBankParser: last-4 and narration from HTML plus a short text part", () => {
  it("takes last-4 from the masked account, never from NGN 76,430.00", () => {
    expect(extractMaskedLast4("NGN 76,430.00")).toBeUndefined();
    expect(extractMaskedLast4("******2468 : Amount : NGN 76,430.00")).toBe("2468");
    const html = parser.parse(R.gensHtmlWithWeakText)!;
    expect(html.accountLast4).toBe("2468");
    expect(html.accountLast4).not.toBe("7643");
    expect(html.amountMinor).toBe(7_643_000n);
    expect(html.description).toContain("ADA OKAFOR");
    expect(html.description).not.toMatch(/^GTBank debit$/i);

    const sameLine = parser.parse(R.gensAccountAndAmountSameLine)!;
    expect(sameLine.accountLast4).toBe("2468");
    expect(sameLine.description).toContain("KEMI ADE");
  });

  it("reads Description from HTML when the text/plain part is only a preview", () => {
    const tx = parser.parse(R.gensHtmlWithWeakText)!;
    expect(tx.description).toContain("NIP/TRANSFER/TO ADA OKAFOR");
    expect(parseEmail(R.gensHtmlWithWeakText).status).toBe("parsed");
  });

  it("parses nested GeNS tables with nbsp labels when the subject has no amount", () => {
    const tx = parser.parse(R.gensNestedNbspTable)!;
    expect(tx).not.toBeNull();
    expect(tx.type).toBe("DEBIT");
    expect(tx.amountMinor).toBe(7_643_000n);
    expect(tx.accountLast4).toBe("2468");
    expect(tx.balanceAfterMinor).toBe(90_000_000n);
    expect(tx.reference).toBe("SYN260002101200001");
    expect(tx.description).toContain("NIP/TRANSFER/TO ADA OKAFOR");
    expect(tx.description).toContain("RENT OCT");
    expect(tx.description).not.toMatch(/^GTBank debit$/i);
    expect(tx.transactionDate.toISOString()).toBe("2026-10-02T11:20:00.000Z");
  });

  it("pairs labels on one table row with values on the next", () => {
    const tx = parser.parse(R.gensLabelThenValueRows)!;
    expect(tx.type).toBe("CREDIT");
    expect(tx.amountMinor).toBe(1_200_000n);
    expect(tx.accountLast4).toBe("2468");
    expect(tx.balanceAfterMinor).toBe(91_200_000n);
    expect(tx.description).toContain("KEMI ADE");
    expect(tx.description).not.toMatch(/^GTBank credit$/i);
  });

  it("falls back to plaintext labels when HTML has no table fields", () => {
    const tx = parser.parse(R.gensTextFallback)!;
    expect(tx.type).toBe("DEBIT");
    expect(tx.amountMinor).toBe(320_000n);
    expect(tx.accountLast4).toBe("2468");
    expect(tx.balanceAfterMinor).toBe(88_800_000n);
    expect(tx.description).toContain("POS SYNTHETIC MART LEKKI");
  });
});

describe("helpers", () => {
  it("parses amounts to minor units without floats", () => {
    expect(parseAmountToMinor("1,983,611.00")).toBe(198_361_100n);
    expect(parseAmountToMinor("0.1")).toBe(10n);
    expect(parseAmountToMinor("5000")).toBe(500_000n);
    expect(parseAmountToMinor(".75")).toBe(75n);
    expect(parseAmountToMinor("12.345")).toBeNull();
    expect(parseAmountToMinor("abc")).toBeNull();
  });

  it("parses Nigerian date formats as Lagos time", () => {
    expect(parseBankDate("05/09/2026")!.toISOString().slice(0, 10)).toBe("2026-09-05");
    expect(parseBankDate("25-Sep-2026")!.toISOString().slice(0, 10)).toBe("2026-09-25");
    expect(parseBankDate("25 September 2026")!.toISOString().slice(0, 10)).toBe("2026-09-25");
    expect(parseBankDate("Sep 25, 2026")!.toISOString().slice(0, 10)).toBe("2026-09-25");
    expect(parseBankDate("25-Sep-26")!.toISOString().slice(0, 10)).toBe("2026-09-25");
    expect(parseBankDate("31/02/2026")).toBeUndefined();
    expect(parseBankDate("not a date")).toBeUndefined();
  });

  it("flattens HTML tables into label : value lines", () => {
    const text = htmlToText("<table><tr><td>Amount</td><td>NGN&nbsp;5,000.00</td></tr></table>");
    expect(text).toBe("Amount : NGN 5,000.00");
  });

  it("flattens nested tables so a label cell and a value cell still pair", () => {
    const text = htmlToText(
      "<table><tr><td><table><tr><td>Available Balance</td></tr></table></td><td><table><tr><td>:</td></tr></table></td><td><table><tr><td>NGN&nbsp;9,000.00</td></tr></table></td></tr></table>",
    );
    expect(text).toContain("Available Balance : NGN 9,000.00");
  });
});
