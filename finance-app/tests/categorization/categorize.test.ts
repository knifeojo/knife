import { describe, expect, it } from "vitest";
import { categorize, extractCounterparty, inferHolderName, isSelf } from "@/core/categorize";

describe("categorize", () => {
  it.each([
    ["POS/BOLT TECHNOLOGY OU/LAGOS NG", "Transport", "Bolt"],
    ["UBER *TRIP HELP.UBER.COM", "Transport", "Uber"],
    ["UBER BV", "Transport", "Uber"],
    ["WEB PURCHASE NETFLIX.COM LOS GATOS", "Subscriptions", "Netflix"],
    ["POS PURCHASE SHOPRITE LEKKI LAGOS", "Food", "Shoprite"],
    ["SMS ALERT CHARGES SEP 2026", "Fees", "Bank charges"],
    ["DSTV SUBSCRIPTION MULTICHOICE", "Utilities", "MultiChoice"],
    ["ATM WDL GTB LEKKI PHASE 1", "Other", "Cash withdrawal"],
  ])("debit %s -> %s", (description, category, merchant) => {
    const c = categorize({ description, type: "DEBIT" });
    expect(c.category).toBe(category);
    expect(c.merchantName).toBe(merchant);
    expect(c.source).toBe("rule");
  });

  it("classifies salary, consulting and Pesa credits as income with subcategories", () => {
    expect(categorize({ description: "NIP/ACME TECHNOLOGIES LTD/SALARY SEPTEMBER 2026", type: "CREDIT" })).toMatchObject({
      category: "Income",
      subcategory: "Salary",
    });
    expect(categorize({ description: "NIP/PESA PAYMENTS LTD/CONSULTING INVOICE 014", type: "CREDIT" }).subcategory).toBe("Consulting");
    expect(categorize({ description: "NIP/PESA PAYMENTS LTD/WALLET PAYOUT", type: "CREDIT" })).toMatchObject({
      subcategory: "Transfer",
      merchantName: "Pesa",
    });
  });

  it("does not treat every transfer as spending on a category", () => {
    const c = categorize({ description: "NIP/JOHN DOE/MISC", type: "DEBIT" });
    expect(c.category).toBe("Transfers");
    expect(c.counterparty).toBe("John Doe");
  });

  it("never classifies a credit as an expense category", () => {
    const c = categorize({ description: "TRF FROM TOLU RENT SHARE", type: "CREDIT" });
    expect(c.category).toBe("Income");
  });

  it("falls back to Other with low confidence", () => {
    const c = categorize({ description: "XYZ ENTERPRISES 00123", type: "DEBIT" });
    expect(c.merchantName).toBeUndefined();
    expect(c).toMatchObject({ category: "Other", source: "default" });
    expect(c.confidence).toBeLessThan(0.5);
  });

  it("user corrections win over global rules", () => {
    const c = categorize(
      { description: "TRF/RENT SEPT/FRM ADA OKAFOR TO OLUWASEUN ADEYEMI", type: "DEBIT" },
      [{ pattern: "oluwaseun adeyemi", canonicalName: "Oluwaseun Adeyemi", category: "Family" }],
    );
    expect(c).toMatchObject({ category: "Family", source: "user", confidence: 1 });
  });

  it("returns only classification fields, never amount/date/reference", () => {
    const c = categorize({ description: "UBER TRIP", type: "DEBIT" });
    expect(Object.keys(c).sort()).toEqual(["category", "confidence", "counterparty", "merchantName", "source", "subcategory"].sort());
  });
});

describe("wallet apps", () => {
  it("treats funding one of your wallets from another as your own transfer", () => {
    expect(categorize({ description: "Money transfer to 12.50 CAD debited from CAD wallet to fund GHS wallet (101.20 GHS)", type: "DEBIT" })).toMatchObject({ category: "Own transfer", subcategory: "Between your wallets" });
  });
});

describe("merchant normalization", () => {
  it.each([
    ["UBER *TRIP", "Uber"], ["Uber BV", "Uber"], ["UBER NG", "Uber"], ["UBER TRIP HELP", "Uber"],
    ["POS CONOIL DIESEL FILLING STATION", "Conoil"], ["TOTALENERGIES FILLING STATION LEKKI", "TotalEnergies"],
    ["CARBON LOAN REPAYMENT DEBIT", "Carbon"],
  ])("%s -> %s", (d, m) => {
    expect(categorize({ description: d, type: "DEBIT" }).merchantName).toBe(m);
  });
});

describe("extractCounterparty", () => {
  it("reads recipient on debits and sender on credits", () => {
    expect(extractCounterparty("TRF/RENT SEPT/FRM ADA OKAFOR TO OLUWASEUN ADEYEMI", "DEBIT")).toBe("Oluwaseun Adeyemi");
    expect(extractCounterparty("TRF FROM TOLU BELLO TO ADA OKAFOR", "CREDIT")).toBe("Tolu Bello");
    expect(extractCounterparty("NIP/ACME TECHNOLOGIES LTD/SALARY", "CREDIT")).toBe("Acme Technologies Ltd");
  });
});

describe("statement narration quirks (from a real GTBank PDF audit)", () => {
  it.each([
    ["VATCHARGES", "Fees"],
    ["Commission on NIP TransferCHARGES", "Fees"],
    ["Instant Payment Outward 000013260925101452001 MONTHLY TO MUSA BELLO - EXPRESS", "Transfers"],
    ["FROM EZE ADA SAVINGS TO KEMI 12GTB LAGOS", "Transfers"],
  ])("%s -> %s", (description, category) => {
    expect(categorize({ description, type: "DEBIT" }).category).toBe(category);
  });

  it("classifies savings interest", () => {
    expect(categorize({ description: "INTEREST CAPITALISED 0008853557:Int.Pd:01-09-2026 to 30-09-2026 Interest run", type: "CREDIT" })).toMatchObject({ category: "Income", subcategory: "Interest", source: "rule" });
  });

  it("extracts names that end at ' - ', digits or a full stop", () => {
    expect(extractCounterparty("Instant Payment Outward 0001 MONTHLY TO MUSA BELLO - EXPRESS", "DEBIT")).toBe("Musa Bello");
    expect(extractCounterparty("FROM EZE ADA SAVINGS TO KEMI 12GTB LAGOS", "DEBIT")).toBe("Kemi");
  });
});

describe("round 2 rules (from categorization audit of a real statement)", () => {
  it.each([
    ["Instant Payment Outward 0001 CLOTHES TO MONIEMFB - BE AWESOME FASHION COMPANY LIMITED - BE AWESOME FASHION COMPANY MOBILE", "Shopping", "Clothing"],
    ["Instant Payment Outward 0001 DADDYS AC TO ZBN - FOUANI-SURULERE SHOWROOM", "Family", "Family support"],
    ["Instant Payment Outward 0001 HAIR TO OPAY - TOLU ADE", "Shopping", "Personal care"],
    ["Instant Payment Outward 0001 CLEANING TO OPAY - BLESSING OKON", "Housing", "Home services"],
    ["Instant Payment Outward 0001 TIRE TO FCMB - IKE AUTOS", "Transport", "Car"],
    ["Instant Payment Outward 0001 LOAN TO REMB - ", "Debt", "Loan repayment"],
    ["Instant Payment Outward 0001 HAPPY BIRTHDAY TO KUDA - AMAKA", "Family", "Gifts"],
    ["TRANSFER BETWEEN CUSTOMERS 0001 FROM EZE ADA TO SQ UAD", "Shopping", "Online payment"],
  ])("%s -> %s / %s", (description, category, subcategory) => {
    expect(categorize({ description, type: "DEBIT" })).toMatchObject({ category, subcategory });
  });

  it("takes the recipient after the bank code, not the bank", () => {
    expect(extractCounterparty("Instant Payment Outward 0001 DADDYS AC TO ZBN - FOUANI-SURULERE SHOWROOM", "DEBIT")).toBe("Fouani-Surulere Showroom");
    expect(extractCounterparty("Instant Payment Outward 0001 X TO MONIEMFB - BE AWESOME FASHION COMPANY LIMITED - BE AWESOME", "DEBIT")).toBe("Be Awesome Fashion Company Limited");
    expect(extractCounterparty("Instant Payment Outward 0001 FUEL TO PALMPAY", "DEBIT")).toBeUndefined();
  });

  it("skips microfinance banks and rejoins words split by PDF line wraps", () => {
    expect(extractCounterparty("Instant Payment Outward 0001 CLEANING TO AELLA - IDONGESIT UMOREN", "DEBIT")).toBe("Idongesit Umoren");
    expect(extractCounterparty("Instant Payment Outward 0001 X TO WEMA - OLUWASEUN SAMUEL EZ E", "DEBIT")).toBe("Oluwaseun Samuel Eze");
    expect(extractCounterparty("Instant Payment Outward 0001 X TO SOME MFB - ADA OBI", "DEBIT")).toBe("Ada Obi");
  });

  it("reads the payer of wallet-style credits written as NAME / memo", () => {
    expect(extractCounterparty("PESAPEER INC / Payroll for Sep 2026", "CREDIT")).toBe("Pesapeer Inc");
    expect(extractCounterparty("Money transfer to ADA / 0123 / GTBank", "CREDIT")).not.toBe("Money Transfer To Ada");
  });

  it("reads the sender of dash-formatted inward transfers", () => {
    expect(extractCounterparty("W5WM-MONIE MFB-DEEL INC", "CREDIT")).toBe("Deel Inc");
    expect(extractCounterparty("0001-OLUWASEUN SAMUEL EZE-110059-PESAPEER LTD .", "CREDIT")).toBe("Pesapeer Ltd");
  });

  it("labels money from companies as business income", () => {
    expect(categorize({ description: "0001-ADA OKAFOR-110059-PESAPEER LTD .", type: "CREDIT" })).toMatchObject({ category: "Income", subcategory: "Business income" });
  });

  it("detects transfers between the holder's own accounts, ignoring stray spaces", () => {
    const owners = ["EZE OLUWASEUN SAMUEL"];
    expect(categorize({ description: "TRANSFER FROM ADA TO EZE OL UWASEUN SAMUEL", type: "DEBIT" }, [], owners).category).toBe("Own transfer");
    expect(categorize({ description: "TRF FROM EZE OLUWASEUN SAMUEL TO TOLU BELLO", type: "DEBIT" }, [], owners).category).not.toBe("Own transfer");
    expect(isSelf("Samuel Eze", owners)).toBe(true);
    expect(isSelf("Samuel Adeyemi", owners)).toBe(false);
  });

  it("infers the holder from FROM-name-TO debits", () => {
    expect(inferHolderName(["X FROM EZE OLUWASEUN SAMUEL TO A", "Y FROM EZE OL UWASEUN SAMUEL TO B", "Z TO C"])).toBe("EZE OLUWASEUN SAMUEL");
    expect(inferHolderName(["X FROM ADA TO B"])).toBeUndefined();
  });
});
