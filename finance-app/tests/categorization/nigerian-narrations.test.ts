import { describe, expect, it } from "vitest";
import { cardMerchant, categorize, lenderMerchant } from "@/core/categorize";

// Synthetic narrations in the shapes GTBank, First Bank and Sterling print. No real names or accounts.
const OWNERS = ["JANE ADA DOE"];
const debit = (description: string, owners = OWNERS) => categorize({ description, type: "DEBIT" }, [], owners);
const credit = (description: string, owners = OWNERS) => categorize({ description, type: "CREDIT" }, [], owners);

describe("a lender named only as someone else's bank", () => {
  it("is a transfer to that person, not a repayment (GTBank, First Bank, Sterling shapes)", () => {
    for (const description of [
      "Instant Payment Outward 000013260925101452001 TO CARBON - JOHN SMITH",
      "FBN MOBILE TRF TO JOHN SMITH/CARBON REF 0001",
      "Sterling: NIP Trf to CARBON/JOHN SMITH",
      "NIP/OUT/0001/TO FAIRMONEY MFB - EMEKA OBI",
      "Instant Payment Outward 0002 TO RENMONEY MFB - EMEKA OBI",
    ]) {
      const c = debit(description);
      expect(c.category, description).toBe("Transfers");
      expect(c.merchantName, description).not.toMatch(/Carbon|FairMoney|Renmoney/);
      expect(c.counterparty, description).toMatch(/John Smith|Emeka Obi/);
    }
  });

  it("still uses the memo the user typed", () => {
    expect(debit("Instant Payment Outward 0003 HAIR TO CARBON - TOLU ADE")).toMatchObject({ category: "Shopping", subcategory: "Personal care", counterparty: "Tolu Ade" });
    expect(debit("Instant Payment Outward 0004 MUM UPKEEP TO CARBON - GRACE DOE")).toMatchObject({ category: "Family", subcategory: "Family support" });
  });

  it("money in from someone who banks with Carbon is not loan proceeds", () => {
    for (const description of ["0001-JOHN SMITH-110059-CARBON", "TRANSFER FROM JOHN SMITH /CARBON"]) {
      const c = credit(description);
      expect(c.category, description).toBe("Income");
      expect(c.merchantName, description).toBe("John Smith");
    }
  });

  it("stays a repayment when the money goes to the lender, to the borrower's own name there, or says repayment", () => {
    expect(debit("NIP TRANSFER TO CARBON")).toMatchObject({ category: "Debt", subcategory: "Loan repayment", merchantName: "Carbon" });
    expect(debit("Instant Payment Outward 0005 TO CARBON - CARBON")).toMatchObject({ category: "Debt", subcategory: "Loan repayment", merchantName: "Carbon" });
    expect(debit("Instant Payment Outward 0006 TO CARBON - JANE ADA DOE")).toMatchObject({ category: "Debt", subcategory: "Loan repayment", merchantName: "Carbon" });
    expect(debit("Instant Payment Outward 0007 TO FAIRMONEY MFB - JANE ADA DOE")).toMatchObject({ category: "Debt", subcategory: "Loan repayment", merchantName: "FairMoney" });
    expect(debit("Instant Payment Outward 0008 LOAN REPAYMENT TO CARBON - JOHN SMITH")).toMatchObject({ category: "Debt", subcategory: "Loan repayment", merchantName: "Carbon" });
    expect(credit("NIP FROM CARBON LOAN DISBURSEMENT")).toMatchObject({ category: "Debt", subcategory: "Loan proceeds", merchantName: "Carbon" });
  });

  it("other banks after TO never decide the category either", () => {
    // MTN MoMo PSB is a bank, so this is not airtime.
    expect(debit("Instant Payment Outward 0009 TO MTN MOMO PSB - JOHN OKAFOR")).toMatchObject({ category: "Transfers", counterparty: "John Okafor" });
    expect(debit("Instant Payment Outward 0010 TO PALMPAY - JOHN OKAFOR").category).toBe("Transfers");
  });
});

describe("FairMoney, Renmoney, Carbon, PalmCredit and other lenders stay debt", () => {
  it.each([
    ["FAIRMONEY LOAN REPAYMENT", "FairMoney"],
    ["NIP TO RENMONEY MFB LOAN", "Renmoney"],
    ["PALMCREDIT LOAN REPAYMENT", "PalmCredit"],
    ["PALM CREDIT REPAYMENT 0001", "PalmCredit"],
    ["Instant Payment Outward 0011 TO PALMCREDIT", "PalmCredit"],
    ["CARBON LOAN REPAYMENT DEBIT", "Carbon"],
    ["NIP Trf to OKASH", "OKash"],
    ["SPECTA LOAN REPAYMENT", "Specta"],
  ])("%s -> Debt (%s)", (description, lender) => {
    expect(debit(description)).toMatchObject({ category: "Debt", merchantName: lender });
  });

  it("PalmPay is a bank, not PalmCredit", () => {
    expect(lenderMerchant("TRF TO PALMPAY - JOHN OKAFOR")).toBeUndefined();
    expect(lenderMerchant("palm credit")).toBe("PalmCredit");
  });
});

describe("memo-only loans", () => {
  it("'LOAN TO <person>' is a personal loan, never a lender to clear", () => {
    for (const description of [
      "Instant Payment Outward 0012 LOAN TO OPAY - JOHN OKAFOR",
      "Instant Payment Outward 0013 LOAN TO CARBON - JOHN SMITH",
      "TRF/LOAN/FRM JANE ADA DOE TO JOHN OKAFOR",
    ]) {
      const c = debit(description);
      expect(c, description).toMatchObject({ category: "Debt", subcategory: "Loans" });
      expect(lenderMerchant(c.merchantName ?? ""), description).toBeUndefined();
    }
  });
});

describe("savings apps", () => {
  it("a deposit is the user's own money moving, whoever the account is named after", () => {
    for (const [description, app] of [
      ["Instant Payment Outward 0014 TO PIGGYVEST SAVINGS", "PiggyVest"],
      ["Sterling: NIP Trf to PIGGYVEST/JANE DOE", "PiggyVest"],
      ["NIP/OUT/0002/TO PIGGYVEST - SAFELOCK", "PiggyVest"],
      ["TRF TO COWRYWISE SAVINGS PLAN", "Cowrywise"],
      ["FBN MOBILE TRF TO RISEVEST REF 0002", "Risevest"],
      ["OWEALTH DEPOSIT", "OWealth"],
    ]) {
      expect(debit(description, []), description).toMatchObject({ category: "Own transfer", subcategory: "Savings", merchantName: app });
    }
  });

  it("money back from a savings app is not income, but interest still is", () => {
    expect(credit("NIP FROM PIGGYVEST WITHDRAWAL")).toMatchObject({ category: "Own transfer", subcategory: "Savings" });
    expect(credit("INTEREST PAID FIXED DEPOSIT 0001")).toMatchObject({ category: "Income", subcategory: "Interest" });
  });

  it("a savings ACCOUNT in a narration is not a savings app", () => {
    expect(debit("FROM EZE ADA SAVINGS TO KEMI 12GTB LAGOS").category).toBe("Transfers");
  });
});

describe("everyday spending from narration", () => {
  it.each([
    // GTBank
    ["POS/WEB PMNT @ BOLT FOOD LAGOS NG", "Food", "Delivery"],
    ["POS/WEB PMNT @ UBER EATS", "Food", "Delivery"],
    ["POS/WEB PMNT @ BOLT TECHNOLOGY OU", "Transport", "Ride hailing"],
    ["Instant Payment Outward 0015 DIESEL FOR GEN TO OPAY - MUSA BELLO", "Housing", "Generator & diesel"],
    ["Instant Payment Outward 0016 DIESEL TO OPAY - MRS OIL LEKKI", "Transport", "Fuel"],
    ["Instant Payment Outward 0017 TITHE TO ZBN - RCCG CHAPEL OF GRACE", "Giving", "Church"],
    ["Instant Payment Outward 0018 SEED OFFERING TO GTB - ADA OBI", "Giving", undefined],
    ["Instant Payment Outward 0019 WIFE UPKEEP TO KUDA - AMAKA DOE", "Family", "Spouse"],
    ["Instant Payment Outward 0020 DRIVER SALARY TO OPAY - SUNDAY OKON", "Housing", "Home services"],
    ["Instant Payment Outward 0021 GYM SUBSCRIPTION TO GTB - I-FITNESS", "Healthcare", "Fitness"],
    ["Instant Payment Outward 0022 DRUGS TO OPAY - BLESSING OKON", "Healthcare", undefined],
    ["Instant Payment Outward 0023 SUYA AND DRINKS TO PALMPAY - MALLAM AUDU", "Food", undefined],
    ["Instant Payment Outward 0024 JAMB FORM TO OPAY - TOLU ADE", "Family", "Education"],
    // First Bank
    ["POS PURCHASE: CHICKEN REPUBLIC IKEJA LANG", "Food", "Eating out"],
    ["POS PURCHASE: MAMA PUT KITCHEN IKEJA LANG", "Food", "Eating out"],
    ["WEB PURCHASE: PRIME VIDEO", "Subscriptions", "Streaming"],
    ["IBEDC PREPAID TOKEN 0123", "Utilities", "Electricity"],
    ["STARTIMES SUBSCRIPTION 0001", "Utilities", "TV"],
    ["VTPASS BILLS PAYMENT", "Utilities", undefined],
    // Sterling
    ["POS-Web Purchase-ABC STORES-LA-NG", "Food", "Groceries"],
    ["POS-Web Purchase-GREENFIELD PHARMACY-LA-NG", "Healthcare", undefined],
    ["Sterling: WEB PURCHASE BET9JA.COM", "Other", "Betting"],
    ["Sterling: POS Purchase-AIR PEACE-LA-NG", "Travel", undefined],
    ["Sterling: NIP Trf to SHUTTLERS", "Transport", "Public transport"],
  ])("%s -> %s / %s", (description, category, subcategory) => {
    expect(debit(description)).toMatchObject({ category, subcategory });
  });

  it("a card payment at an unknown shop is a purchase to review, not a transfer", () => {
    expect(debit("POS PURCHASE: QWERTY 123")).toMatchObject({ category: "Shopping", subcategory: "Card purchase", merchantName: "Qwerty", source: "default" });
    expect(debit("POS PURCHASE: QWERTY 123").confidence).toBeLessThan(0.5);
  });

  it("reads the shop out of card narrations", () => {
    expect(cardMerchant("POS/WEB PMNT @ ABC STORES LEKKI LA NG")).toBe("Abc Stores");
    expect(cardMerchant("POS PURCHASE: MAMA PUT KITCHEN IKEJA LANG")).toBe("Mama Put Kitchen");
    expect(cardMerchant("POS-Web Purchase-XYZ VENTURES-LA-NG")).toBe("Xyz Ventures");
    expect(cardMerchant("GTWORLD WEB TRANSFER TO JOHN OKAFOR")).toBeUndefined();
    expect(cardMerchant("NIP TRANSFER TO JOHN OKAFOR")).toBeUndefined();
  });

  it("betting winnings are income; a POS cash-out is cash", () => {
    expect(credit("NIP FROM SPORTYBET WINNINGS")).toMatchObject({ category: "Income", merchantName: "SportyBet" });
    expect(debit("POS WITHDRAWAL AGENT 0001")).toMatchObject({ category: "Other", subcategory: "Cash" });
  });

  it("refuses to guess from a bare person-to-person transfer", () => {
    expect(debit("FIP:MB:TRF TO JOHN OKAFOR/GTB/0001")).toMatchObject({ category: "Transfers", source: "default" });
  });
});
