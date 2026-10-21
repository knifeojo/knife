import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { importStatement } from "@/core/statement-import";
import { monthPeriod, spendingByCategory, summary } from "@/core/analytics";

// Made-up GTBank rows. The reversal is a credit and should reduce Fees, not add income or fee spend.
const STATEMENT = [
  "Guaranty Trust Bank",
  "Currency: NGN",
  "Account No,0123456789",
  "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
  "01-Sep-2026,R1,50.00,,1000.00,Commission on NIP TransferCHARGES",
  "02-Sep-2026,R2,7.50,,992.50,VATCHARGES",
  "03-Sep-2026,R3,50.00,,942.50,STAMP DUTY CHARGE",
  "04-Sep-2026,R4,4.00,,938.50,SMS ALERT CHARGE",
  "05-Sep-2026,R5,,50.00,988.50,REVERSED : Commission on NIP TransferCHARGES",
].join("\n");

describe("reversed GTBank fees", () => {
  it("nets the credit against Fees and leaves real charges as fee spend", async () => {
    const user = await db.user.create({ data: { email: "fee-refund@test.dev" } });
    const imported = await importStatement(user.id, { name: "gtbank.csv", bytes: Buffer.from(STATEMENT) });
    expect(imported).toMatchObject({ institution: "GTBank", currency: "NGN", errors: [], balanceBreaks: 0, complete: true, created: 5 });

    const rows = await db.transaction.findMany({ where: { userId: user.id }, orderBy: { transactionDate: "asc" } });
    expect(rows.map((t) => [t.type, t.category, t.subcategory])).toEqual([
      ["DEBIT", "Fees", null],
      ["DEBIT", "Fees", null],
      ["DEBIT", "Fees", null],
      ["DEBIT", "Fees", null],
      ["CREDIT", "Fees", "Refund"],
    ]);
    expect(rows[4].merchantName).toBe("Bank charges");

    const period = monthPeriod(new Date("2026-09-15T12:00:00Z"));
    const s = await summary(user.id, period);
    // 50.00 + 7.50 + 50.00 + 4.00 − 50.00 reversal.
    expect(s.income).toBe(0n);
    expect(s.expenses).toBe(6_150n);
    const fees = (await spendingByCategory(user.id, period)).find((c) => c.category === "Fees");
    expect(fees).toMatchObject({ total: 6_150n });
  });
});