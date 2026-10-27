import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { importStatement } from "@/core/statement-import";
import { monthPeriod, summary } from "@/core/analytics";
import { makePesaPdf } from "../fixtures/pesa-pdf";

const DEEL_COLS = [
  "ID", "Date Requested", "Transaction Status", "Transaction Type", "Currency", "Transaction Amount",
  "Provider Fee", "Amount Transferred", "Currency Transferred", "Client", "Contract Name", "Contract URL",
  "Invoice URL", "Withdraw Method", "Withdraw Method Custom Name", "Withdraw Account Holder Name",
  "Trace ID", "Trace ID Type", "Transaction Statement URL", "Exchange Rate Fees", "Exchange Rate",
  "Cross Border Fees", "Provider Fees",
];
const deelRow = (r: Record<string, string>) => DEEL_COLS.map((c) => r[c] ?? "").join(",");
const DEEL = [
  DEEL_COLS.join(","),
  deelRow({ ID: "cp-1", "Date Requested": "2026-03-01 14:05:09", "Transaction Status": "completed", "Transaction Type": "client_payment", Currency: "USD", "Transaction Amount": "4000.00", "Amount Transferred": "4000.00", "Currency Transferred": "USD", Client: "ACME INC", "Contract Name": "Design contract" }),
  deelRow({ ID: "wd-1", "Date Requested": "2026-03-02 09:00:00", "Transaction Status": "completed", "Transaction Type": "withdrawal", Currency: "USD", "Transaction Amount": "-1250.00", "Provider Fee": "5.00", "Amount Transferred": "1912654.31", "Currency Transferred": "NGN", "Withdraw Method": "bank_transfer", "Withdraw Method Custom Name": "GTBank", "Withdraw Account Holder Name": "JANE ADA DOE", "Trace ID": "tr-9", "Exchange Rate": "1530.12345" }),
  deelRow({ ID: "wd-skip", "Date Requested": "2026-03-03 09:00:00", "Transaction Status": "cancelled", "Transaction Type": "withdrawal", Currency: "USD", "Transaction Amount": "-80.00", "Amount Transferred": "120000.00", "Currency Transferred": "NGN", "Withdraw Account Holder Name": "JANE ADA DOE", "Exchange Rate": "1500" }),
  deelRow({ ID: "cp-fail", "Date Requested": "2026-03-04 09:00:00", "Transaction Status": "failure", "Transaction Type": "client_payment", Currency: "USD", "Transaction Amount": "500.00", Client: "ACME INC" }),
  deelRow({ ID: "adv-1", "Date Requested": "2026-03-05 11:00:00", "Transaction Status": "completed", "Transaction Type": "advance", Currency: "USD", "Transaction Amount": "800.00" }),
  deelRow({ ID: "fee-1", "Date Requested": "2026-03-05 11:01:00", "Transaction Status": "completed", "Transaction Type": "advance_fee", Currency: "USD", "Transaction Amount": "-25.00" }),
  deelRow({ ID: "rep-1", "Date Requested": "2026-03-20 11:00:00", "Transaction Status": "completed", "Transaction Type": "advance_repayment", Currency: "USD", "Transaction Amount": "-800.00" }),
  deelRow({ ID: "card-1", "Date Requested": "2026-03-21 11:00:00", "Transaction Status": "completed", "Transaction Type": "deel_card_withdrawal", Currency: "USD", "Transaction Amount": "-40.00", "Withdraw Method": "deel_card" }),
].join("\n");

const GT_USD = [
  "Guaranty Trust Bank",
  "Currency: USD",
  "Account Number,0099111222",
  "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
  "26-Oct-2025,R500,,500.00,500.00,INWARD TRANSFER FROM JANE ADA DOE",
].join("\n");

const LENDERS = [
  "Date,Narration,Debit,Credit",
  "01/03/2026,SALARY FROM ACME,,100000.00",
  "02/03/2026,TRANSFER FROM FAIRMONEY DISBURSEMENT,,50000.00",
  "03/03/2026,NIP FROM RENMONEY,,25000.00",
  "04/03/2026,NIP TO RENMONEY REPAYMENT,20000.00,",
  "05/03/2026,TRANSFER TO FAIRMONEY,15000.00,",
].join("\n");

describe("uploading Pesa and Deel statements", () => {
  it("imports a Pesa PDF, categorises each row, and pairs an own-name send with the bank credit", async () => {
    const user = await db.user.create({ data: { email: "pesa-upload@test.dev" } });
    const pdf = await makePesaPdf();
    const first = await importStatement(user.id, { name: "wallet.pdf", bytes: pdf });
    expect(first).toMatchObject({ institution: "Pesa", currency: "USD", accountLast4: "6789", created: 4, duplicates: 0, errors: [], complete: true });
    const again = await importStatement(user.id, { name: "wallet.pdf", bytes: pdf });
    expect(again).toMatchObject({ created: 0, duplicates: 4 });

    const rows = await db.transaction.findMany({ where: { userId: user.id }, orderBy: { transactionDate: "asc" } });
    const byDesc = (part: string) => rows.find((t) => t.description.includes(part))!;
    expect(byDesc("Payroll")).toMatchObject({ category: "Income", subcategory: "Salary", type: "CREDIT", amountMinor: 400_000n });
    expect(byDesc("DOE JANE ADA")).toMatchObject({ category: "Own transfer", type: "DEBIT", amountMinor: 50_000n });
    expect(byDesc("fund GBP wallet")).toMatchObject({ category: "Own transfer", subcategory: "Between your wallets", amountMinor: 500n, currency: "CAD" });
    expect(byDesc("reversed")).toMatchObject({ category: "Transfers", subcategory: "Reversal", type: "CREDIT", amountMinor: 5_000n });
    expect((await db.account.findFirstOrThrow({ where: { userId: user.id, institution: "Pesa" } })).holderName).toBe("JANE ADA DOE");

    await importStatement(user.id, { name: "gtb-usd.csv", bytes: Buffer.from(GT_USD) });
    const send = await db.transaction.findFirstOrThrow({ where: { userId: user.id, description: { contains: "DOE JANE ADA" } } });
    const credit = await db.transaction.findFirstOrThrow({ where: { userId: user.id, reference: "R500" } });
    expect(send.transferPairId).toBe(credit.id);
    expect(credit.transferPairId).toBe(send.id);
  });

  it("imports a Deel CSV: completed rows only, advances as a loan, withdrawals teach an FX rate", async () => {
    const user = await db.user.create({ data: { email: "deel-upload@test.dev" } });
    const first = await importStatement(user.id, { name: "deel-transactions.csv", bytes: Buffer.from(DEEL) });
    expect(first).toMatchObject({ institution: "Deel", currency: "USD", created: 6, duplicates: 0, errors: [] });
    const again = await importStatement(user.id, { name: "deel-transactions.csv", bytes: Buffer.from(DEEL) });
    expect(again).toMatchObject({ created: 0, duplicates: 6 });
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(6);
    expect(await db.transaction.findFirst({ where: { userId: user.id, sourceTransactionId: { contains: "wd-skip" } } })).toBeNull();
    expect(await db.transaction.findFirst({ where: { userId: user.id, sourceTransactionId: { contains: "cp-fail" } } })).toBeNull();

    const rows = await db.transaction.findMany({ where: { userId: user.id } });
    const byId = (id: string) => rows.find((t) => t.sourceTransactionId === `deel:${id}`)!;
    expect(byId("cp-1")).toMatchObject({ category: "Income", subcategory: "Consulting", type: "CREDIT" });
    expect(byId("wd-1")).toMatchObject({ category: "Own transfer", fxQuoteCurrency: "NGN", fxQuoteMinor: 191_265_431n });
    expect(byId("adv-1")).toMatchObject({ category: "Debt", subcategory: "Loan proceeds", type: "CREDIT" });
    expect(byId("fee-1")).toMatchObject({ category: "Fees", subcategory: "Advance fee", type: "DEBIT" });
    expect(byId("rep-1")).toMatchObject({ category: "Debt", subcategory: "Loan repayment", type: "DEBIT" });
    expect(byId("card-1")).toMatchObject({ category: "Own transfer", subcategory: "Between your wallets" });

    const march = monthPeriod(new Date("2026-03-15T12:00:00Z"));
    const s = await summary(user.id, march);
    const rate = Number(byId("wd-1").fxQuoteMinor) / Number(byId("wd-1").amountMinor);
    expect(s.ratesUsed.map((r) => r.currency)).toEqual(["USD"]);
    expect(s.unconverted).toEqual([]);
    // Only the client payment is income. The advance is a loan, the withdrawal is the user's own money.
    expect(Number(s.income)).toBe(Math.round(400_000 * rate));
  });

  it("keeps FairMoney and Renmoney disbursements out of income and repayments in debt", async () => {
    const user = await db.user.create({ data: { email: "lenders@test.dev" } });
    await importStatement(user.id, { name: "gtb.csv", bytes: Buffer.from(LENDERS) }, { institution: "GTBank" });
    const rows = await db.transaction.findMany({ where: { userId: user.id } });
    const by = (part: string) => rows.find((t) => t.description.includes(part))!;
    expect(by("SALARY")).toMatchObject({ category: "Income", subcategory: "Salary" });
    expect(by("FAIRMONEY DISBURSEMENT")).toMatchObject({ category: "Debt", subcategory: "Loan proceeds", merchantName: "FairMoney" });
    expect(by("FROM RENMONEY")).toMatchObject({ category: "Debt", subcategory: "Loan proceeds", merchantName: "Renmoney" });
    expect(by("RENMONEY REPAYMENT")).toMatchObject({ category: "Debt", subcategory: "Loan repayment", merchantName: "Renmoney" });
    expect(by("TO FAIRMONEY")).toMatchObject({ category: "Debt", subcategory: "Loan repayment", merchantName: "FairMoney" });

    const s = await summary(user.id, monthPeriod(new Date("2026-03-15T12:00:00Z")));
    expect(s.income).toBe(10_000_000n);
    expect(s.expenses).toBe(3_500_000n);
  });
});