import { describe, expect, it } from "vitest";
import { parsePesaStatement, pesaCurrency } from "@/core/parsers/pesa";
import { pdfToPlainText } from "@/core/pdf-statement";
import { reconcile } from "@/core/statements";
import { makePesaPdf, makeTextPdf } from "../fixtures/pesa-pdf";

// Made-up wallet text. Page breaks glue the repeated header into a row, split a date from its
// year, and leave a balance on the next page's first line. Digits are real here so the running
// balance can be checked; the shapes match statement rows that failed import.
const PAGE_BREAK_TEXT = `Account Statement
JANE ADA
DOE
Email: jane@example.com
Date Issued: Oct 20, 2026
Period: Oct 20, 2025 - Oct 20, 2026
Wallet: CAOO123456789
Balance: $100.00
Date Transaction Details Amount($) Balance($)
Oct 25,
2025 ACME INC / Payroll for Oct 2025 1,000.00 1,100.00
Oct 26, 2025 Money transfer to JOHN DOE (200.00) 900.00
Date Transaction Details Amount($) Balance($)
Oct 27, Money transfer to JOHN DOE (
Continued on next page
Page 1 of 3
\fDate Transaction Details Amount($) Balance($)
2025 (50.00) 850.00
Nov 3, 2025 Payout of $40.00 was successfully reversed 40.00 890.00
Page 2 of 3
Date Transaction Details Amount($) Balance($)
Nov 4, 2025 Money transfer to PAYSTACK CHECKOUT / 1234567890 /
TITAN-PAYSTACKMicrofinance (15.00)
\fNov 5, 2025 875.00 Money transfer to JOHN DOE / 0987654321 /
GuarantyTrust Bank (25.00) 850.00
Dec 1,
2025 700.00
Date Transaction Details Amount($) Balance($)
Money transfer to JOHN DOE (150.00)
Dec 2, 2025 ACME INC / Bonus 100.00 800.00
`;

// Synthetic Pesa wallet text. Names, the email and the amounts are made up.
const PESA_TEXT = `Account Statement
JANE ADA
DOE
Email: jane@example.com
Date Issued: Oct 20, 2026
Period: Oct 20, 2025 - Oct 20, 2026
Wallet: CAOO123456789
Balance: $1.23
Date Transaction Details Amount
($)
Balance
($)
Oct 25,
2025 ACME INC / Payroll for Oct 2025 4,000.00 4,120.50
Oct 26,
2025 Money transfer to DOE JANE ADA (500.00) 3,620.50
Oct 27,
2025 Money transfer to SOME SHOP LTD (1,200.00) 2,420.50
Oct 28,
2025
Money transfer to 5.00 CAD debited from CAD wallet to fund GBP wallet (2.70
GBP) (3.60) 2,416.90
Nov 3, 2025 Payout of $50.00 was successfully reversed 50.00 2,466.90
Date Transaction Details Amount
($)
Balance
($)
Nov 4, 2025 Money transfer to John Smith (40.00) 2,426.90
Feb 2, 2026 ACME INC / Team offsite trip reimbursement 300.00 300.00
`;

describe("Pesa wallet text", () => {
  it("parses wrapped dates and narrations, debits in parentheses, and the printed balance", () => {
    const parsed = parsePesaStatement(PESA_TEXT);
    expect(parsed).not.toBeNull();
    expect(parsed!.currency).toBe("USD");
    expect(parsed!.result.errors).toEqual([]);
    expect(parsed!.result.holder).toBe("JANE ADA DOE");
    expect(parsed!.result.accountLast4).toBe("6789");
    expect(parsed!.result.transactions.map((t) => [t.transactionDate.toISOString().slice(0, 10), t.type, t.amountMinor, t.balanceAfterMinor])).toEqual([
      ["2025-10-25", "CREDIT", 400_000n, 412_050n],
      ["2025-10-26", "DEBIT", 50_000n, 362_050n],
      ["2025-10-27", "DEBIT", 120_000n, 242_050n],
      ["2025-10-28", "DEBIT", 360n, 241_690n],
      ["2025-11-03", "CREDIT", 5_000n, 246_690n],
      ["2025-11-04", "DEBIT", 4_000n, 242_690n],
      ["2026-02-02", "CREDIT", 30_000n, 30_000n],
    ]);
    const fx = parsed!.result.transactions[3];
    expect(fx.description).toContain("debited from CAD wallet to fund GBP wallet");
    expect(fx.description).toContain("2.70 GBP");
    expect(fx.description).not.toContain("2,416.90");
    expect(parsed!.result.transactions[0].description).toBe("ACME INC / Payroll for Oct 2025");
    expect(parsed!.result.transactions[1].description).toBe("Money transfer to DOE JANE ADA");
    expect(parsed!.result.transactions[4].description).toContain("reversed");
  });

  it("does not treat a CA-letter wallet id as Canadian dollars", () => {
    expect(pesaCurrency("Wallet: CAOO123456789\nBalance: $1.23", "CAOO123456789")).toBe("USD");
    expect(pesaCurrency("Wallet: CA001234561723", "CA001234561723")).toBe("CAD");
    expect(pesaCurrency("Currency: GBP\nWallet: CAOO123456789", "CAOO123456789")).toBe("GBP");
  });

  it("ignores a bank statement that is not a Pesa wallet", () => {
    expect(parsePesaStatement("Guaranty Trust Bank\nAccount No: 0123454521\nCurrency: NGN")).toBeNull();
  });

  it("stitches rows split by a page header and keeps the running balance", () => {
    const parsed = parsePesaStatement(PAGE_BREAK_TEXT.replaceAll("\f", "\n"));
    expect(parsed).not.toBeNull();
    expect(parsed!.result.errors).toEqual([]);
    const rows = parsed!.result.transactions;
    expect(rows.map((t) => [t.transactionDate.toISOString().slice(0, 10), t.type, t.amountMinor, t.balanceAfterMinor])).toEqual([
      ["2025-10-25", "CREDIT", 100_000n, 110_000n],
      ["2025-10-26", "DEBIT", 20_000n, 90_000n],
      ["2025-10-27", "DEBIT", 5_000n, 85_000n],
      ["2025-11-03", "CREDIT", 4_000n, 89_000n],
      ["2025-11-04", "DEBIT", 1_500n, 87_500n],
      ["2025-11-05", "DEBIT", 2_500n, 85_000n],
      ["2025-12-01", "DEBIT", 15_000n, 70_000n],
      ["2025-12-02", "CREDIT", 10_000n, 80_000n],
    ]);
    const payout = rows[3];
    expect(payout.description).toContain("reversed");
    expect(payout.description).toContain("$40.00");
    expect(payout.type).toBe("CREDIT");
    expect(rows[2].description).toBe("Money transfer to JOHN DOE");
    expect(rows[4].description).toBe("Money transfer to PAYSTACK CHECKOUT / 1234567890 / TITAN-PAYSTACKMicrofinance");
    expect(rows[5].description).toBe("Money transfer to JOHN DOE / 0987654321 / GuarantyTrust Bank");
    expect(rows[6].description).toBe("Money transfer to JOHN DOE");
    expect(reconcile(rows)).toMatchObject({ breaks: 0, gapMinor: 0n });
  });
});

describe("Pesa wallet PDF", () => {
  it("reads wrapped date and narration lines out of the text layer", async () => {
    const text = await pdfToPlainText(await makePesaPdf());
    const parsed = parsePesaStatement(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.result.errors).toEqual([]);
    expect(parsed!.currency).toBe("USD");
    expect(parsed!.result.holder).toBe("JANE ADA DOE");
    expect(parsed!.result.transactions.map((t) => [t.type, t.amountMinor])).toEqual([
      ["CREDIT", 400_000n],
      ["DEBIT", 50_000n],
      ["DEBIT", 360n],
      ["CREDIT", 5_000n],
    ]);
    expect(parsed!.result.transactions[2].description).toContain("fund GBP wallet");
    expect(parsed!.result.transactions[2].description).toContain("GBP");
  });

  it("reads a row that starts on one page and finishes after the next page's header", async () => {
    const text = await pdfToPlainText(await makeTextPdf(PAGE_BREAK_TEXT));
    const parsed = parsePesaStatement(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.result.errors).toEqual([]);
    expect(parsed!.result.transactions.map((t) => [t.type, t.amountMinor, t.balanceAfterMinor])).toEqual([
      ["CREDIT", 100_000n, 110_000n],
      ["DEBIT", 20_000n, 90_000n],
      ["DEBIT", 5_000n, 85_000n],
      ["CREDIT", 4_000n, 89_000n],
      ["DEBIT", 1_500n, 87_500n],
      ["DEBIT", 2_500n, 85_000n],
      ["DEBIT", 15_000n, 70_000n],
      ["CREDIT", 10_000n, 80_000n],
    ]);
    expect(parsed!.result.transactions[3].type).toBe("CREDIT");
    expect(reconcile(parsed!.result.transactions)).toMatchObject({ breaks: 0, gapMinor: 0n });
  });
});

// The balance column of a row can land on the previous row, leaving this one as
// "Money transfer to JOHN DOE (9.99)" with no amount column of its own. The parenthesis is the
// amount. A same-day pair is listed backwards. Digits are made up; the shapes match the rows that
// still failed after page-break stitching. Reading the leaked 10,100.00 as a credit would report a
// gap of about $10,100 for a $200 transfer.
const PAREN_ONLY_TEXT = `Account Statement
JANE ADA
DOE
Email: jane@example.com
Date Issued: Oct 20, 2026
Period: Oct 20, 2025 - Oct 20, 2026
Wallet: CAOO123456789
Balance: $0.00
Date Transaction Details Amount($) Balance($)
Oct 25, 2025 ACME INC / Payroll for Oct 2025 10,300.00 10,300.00
Oct 26, 2025 Money transfer to JANE SMITH (200.00) 10,100.00
10,090.01
Oct 27, 2025 Money transfer to JOHN DOE (9.99)
Oct 28, 2025 Money transfer to JOHN DOE (999.99)
Oct 29, 2025 Money transfer to PAYSTACK CHECKOUT / 1234567890 /
TITAN-PAYSTACKMicrofinance (99.99) 8,990.03
Oct 30, 2025 ACME INC / Bonus 50.00 9,030.03
Oct 30, 2025 Money transfer to JOHN DOE (10.00) 8,980.03
Oct 31, 2025 Payout of $20.00 was successfully reversed 20.00 9,050.03
Nov 1, 2025 Payout of $15.00 was successfully reversed (15.00)
Nov 2, 2025 ACME INC / Payroll top up 100.00 9,165.03
`;

describe("Pesa rows whose balance column landed elsewhere", () => {
  it("uses the parenthetical as the amount and orders same-day rows by the running balance", () => {
    const parsed = parsePesaStatement(PAREN_ONLY_TEXT);
    expect(parsed).not.toBeNull();
    expect(parsed!.result.errors).toEqual([]);
    const rows = parsed!.result.transactions;
    expect(rows.map((t) => [t.transactionDate.toISOString().slice(0, 10), t.type, t.amountMinor, t.balanceAfterMinor])).toEqual([
      ["2025-10-25", "CREDIT", 1_030_000n, 1_030_000n],
      ["2025-10-26", "DEBIT", 20_000n, 1_010_000n],
      ["2025-10-27", "DEBIT", 999n, 1_009_001n],
      ["2025-10-28", "DEBIT", 99_999n, 909_002n],
      ["2025-10-29", "DEBIT", 9_999n, 899_003n],
      ["2025-10-30", "DEBIT", 1_000n, 898_003n],
      ["2025-10-30", "CREDIT", 5_000n, 903_003n],
      ["2025-10-31", "CREDIT", 2_000n, 905_003n],
      ["2025-11-01", "CREDIT", 1_500n, 906_503n],
      ["2025-11-02", "CREDIT", 10_000n, 916_503n],
    ]);
    expect(rows.map((t) => t.description)).toEqual([
      "ACME INC / Payroll for Oct 2025",
      "Money transfer to JANE SMITH",
      "Money transfer to JOHN DOE",
      "Money transfer to JOHN DOE",
      "Money transfer to PAYSTACK CHECKOUT / 1234567890 / TITAN-PAYSTACKMicrofinance",
      "Money transfer to JOHN DOE",
      "ACME INC / Bonus",
      "Payout of $20.00 was successfully reversed",
      "Payout of $15.00 was successfully reversed",
      "ACME INC / Payroll top up",
    ]);
    expect(reconcile(rows)).toMatchObject({ breaks: 0, gapMinor: 0n });
  });

  it("reads the same rows from a PDF text layer", async () => {
    const text = await pdfToPlainText(await makeTextPdf(PAREN_ONLY_TEXT));
    const parsed = parsePesaStatement(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.result.errors).toEqual([]);
    expect(reconcile(parsed!.result.transactions)).toMatchObject({ breaks: 0, gapMinor: 0n });
    expect(parsed!.result.transactions).toHaveLength(10);
    expect(parsed!.result.transactions[2]).toMatchObject({ type: "DEBIT", amountMinor: 999n, description: "Money transfer to JOHN DOE" });
    expect(parsed!.result.transactions[8].type).toBe("CREDIT");
  });
});
