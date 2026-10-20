import { describe, expect, it } from "vitest";
import { ngnMinorFromRate, parseDeelCsv } from "@/core/parsers/deel";
import { parseCsv } from "@/core/statements";

const COLS = [
  "ID", "Date Requested", "Transaction Status", "Transaction Type", "Currency", "Transaction Amount",
  "Provider Fee", "Amount Transferred", "Currency Transferred", "Client", "Contract Name", "Contract URL",
  "Invoice URL", "Withdraw Method", "Withdraw Method Custom Name", "Withdraw Account Holder Name",
  "Trace ID", "Trace ID Type", "Transaction Statement URL", "Exchange Rate Fees", "Exchange Rate",
  "Cross Border Fees", "Provider Fees",
];

function csv(rows: Record<string, string>[]): string {
  const line = (r: Record<string, string>) => COLS.map((c) => {
    const v = r[c] ?? "";
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(",");
  return [COLS.join(","), ...rows.map(line)].join("\n");
}

const COMPLETED = csv([
  { ID: "cp-1", "Date Requested": "2026-03-01 14:05:09", "Transaction Status": "completed", "Transaction Type": "client_payment", Currency: "USD", "Transaction Amount": "4000.00", "Amount Transferred": "4000.00", "Currency Transferred": "USD", Client: "ACME INC", "Contract Name": "Design contract" },
  { ID: "wd-1", "Date Requested": "2026-03-02 09:00:00", "Transaction Status": "completed", "Transaction Type": "withdrawal", Currency: "USD", "Transaction Amount": "-1250.00", "Provider Fee": "5.00", "Amount Transferred": "1912654.31", "Currency Transferred": "NGN", "Withdraw Method": "bank_transfer", "Withdraw Method Custom Name": "GTBank", "Withdraw Account Holder Name": "JANE ADA DOE", "Trace ID": "tr-9", "Exchange Rate": "1530.12345" },
  { ID: "wd-skip", "Date Requested": "2026-03-03 09:00:00", "Transaction Status": "cancelled", "Transaction Type": "withdrawal", Currency: "USD", "Transaction Amount": "-100.00", "Amount Transferred": "150000.00", "Currency Transferred": "NGN", "Withdraw Account Holder Name": "JANE ADA DOE", "Exchange Rate": "1530" },
  { ID: "cp-fail", "Date Requested": "2026-03-04 09:00:00", "Transaction Status": "failure", "Transaction Type": "client_payment", Currency: "USD", "Transaction Amount": "500.00", Client: "ACME INC" },
  { ID: "adv-1", "Date Requested": "2026-03-05 11:00:00", "Transaction Status": "completed", "Transaction Type": "advance", Currency: "USD", "Transaction Amount": "800.00" },
  { ID: "fee-1", "Date Requested": "2026-03-05 11:01:00", "Transaction Status": "completed", "Transaction Type": "advance_fee", Currency: "USD", "Transaction Amount": "-25.00" },
  { ID: "rep-1", "Date Requested": "2026-03-20 11:00:00", "Transaction Status": "completed", "Transaction Type": "advance_repayment", Currency: "USD", "Transaction Amount": "-800.00" },
  { ID: "card-1", "Date Requested": "2026-03-21 11:00:00", "Transaction Status": "completed", "Transaction Type": "deel_card_withdrawal", Currency: "USD", "Transaction Amount": "-40.00", "Withdraw Method": "deel_card" },
  { ID: "wd-rate", "Date Requested": "2026-03-22 08:00:00", "Transaction Status": "completed", "Transaction Type": "withdrawal", Currency: "USD", "Transaction Amount": "-100.00", "Currency Transferred": "NGN", "Withdraw Account Holder Name": "JANE ADA DOE", "Exchange Rate": "1530.12345" },
  { ID: "bad-1", "Date Requested": "not-a-date", "Transaction Status": "completed", "Transaction Type": "client_payment", Currency: "USD", "Transaction Amount": "10.00", Client: "ACME INC" },
]);

describe("Deel transactions CSV", () => {
  it("posts only completed rows and quotes NGN on withdrawals", () => {
    expect(ngnMinorFromRate(10_000n, "1530.12345")).toBe(15_301_235n);
    const parsed = parseDeelCsv(parseCsv(COMPLETED));
    expect(parsed).not.toBeNull();
    expect(parsed!.currency).toBe("USD");
    expect(parsed!.result.holder).toBe("JANE ADA DOE");
    expect(parsed!.result.errors.map((e) => e.reason)).toEqual(["Unreadable date"]);
    const txs = parsed!.result.transactions;
    expect(txs.map((t) => t.sourceTransactionId)).toEqual(["deel:cp-1", "deel:wd-1", "deel:adv-1", "deel:fee-1", "deel:rep-1", "deel:card-1", "deel:wd-rate"]);
    expect(txs.map((t) => [t.type, t.amountMinor])).toEqual([
      ["CREDIT", 400_000n],
      ["DEBIT", 125_000n],
      ["CREDIT", 80_000n],
      ["DEBIT", 2_500n],
      ["DEBIT", 80_000n],
      ["DEBIT", 4_000n],
      ["DEBIT", 10_000n],
    ]);
    expect(txs[0].description).toBe("ACME INC / Deel client payment / Design contract");
    expect(txs[0].fxQuoteMinor).toBeUndefined();
    expect(txs[1].description).toContain("JANE ADA DOE");
    expect(txs[1].description).toContain("GTBank");
    expect(txs[1].description).toContain("Deel withdrawal");
    expect(txs[1]).toMatchObject({ fxQuoteCurrency: "NGN", fxQuoteMinor: 191_265_431n, reference: "tr-9" });
    expect(txs[2].description).toBe("Deel advance");
    expect(txs[3].description).toBe("Deel advance fee");
    expect(txs[4].description).toBe("Deel advance repayment");
    expect(txs[5].description).toBe("Deel card withdrawal");
    expect(txs[6]).toMatchObject({ fxQuoteCurrency: "NGN", fxQuoteMinor: 15_301_235n });
    expect(txs.some((t) => t.sourceTransactionId.includes("wd-skip") || t.sourceTransactionId.includes("cp-fail"))).toBe(false);
    expect(txs[1].transactionDate.toISOString().slice(0, 10)).toBe("2026-03-02");
  });

  it("does not claim a normal bank CSV", () => {
    expect(parseDeelCsv([["Date", "Narration", "Debit", "Credit"], ["01/03/2026", "SALARY", "", "10"]])).toBeNull();
  });
});
