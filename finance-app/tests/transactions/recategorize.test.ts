import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { importStatement } from "@/core/statement-import";

const ROOT = path.resolve(import.meta.dirname, "../..");

const FEES = [
  "Guaranty Trust Bank",
  "Currency: NGN",
  "Account No,0123456789",
  "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
  "01-Sep-2026,R1,50.00,,1000.00,Commission on NIP TransferCHARGES",
  "02-Sep-2026,R2,7.50,,992.50,VATCHARGES",
  "03-Sep-2026,R3,4.00,,988.50,SMS ALERT CHARGE",
  "04-Sep-2026,R4,,50.00,1038.50,REVERSED : Commission on NIP TransferCHARGES",
].join("\n");

function runRecategorize(email: string): string {
  return execFileSync(path.join(ROOT, "node_modules/.bin/tsx"), ["src/scripts/recategorize.ts", "--email", email], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("npm run recategorize", () => {
  it("re-labels rule rows for one user, leaves hand-set and linked rows, and is idempotent", async () => {
    const owner = await db.user.create({ data: { email: "recat-owner@test.dev" } });
    const other = await db.user.create({ data: { email: "recat-other@test.dev" } });
    await importStatement(owner.id, { name: "fees.csv", bytes: Buffer.from(FEES) });
    await importStatement(other.id, { name: "fees.csv", bytes: Buffer.from(FEES) });

    const reversal = await db.transaction.findFirstOrThrow({ where: { userId: owner.id, description: { contains: "REVERSED" } } });
    const sms = await db.transaction.findFirstOrThrow({ where: { userId: owner.id, description: { contains: "SMS" } } });
    const vat = await db.transaction.findFirstOrThrow({ where: { userId: owner.id, description: { contains: "VAT" } } });
    // What an import from before the fee-refund rule stored, plus a label the user set, plus a linked transfer.
    await db.transaction.update({ where: { id: reversal.id }, data: { category: "Fees", subcategory: null, classificationSource: "rule", merchantName: "Bank charges" } });
    await db.transaction.update({ where: { id: sms.id }, data: { category: "Food", subcategory: "Groceries", classificationSource: "user" } });
    await db.transaction.update({ where: { id: vat.id }, data: { category: "Own transfer", subcategory: "Between own accounts", classificationSource: "pair", transferPairId: vat.id } });
    const otherReversal = await db.transaction.findFirstOrThrow({ where: { userId: other.id, description: { contains: "REVERSED" } } });
    await db.transaction.update({ where: { id: otherReversal.id }, data: { category: "Fees", subcategory: null, classificationSource: "rule" } });

    const first = runRecategorize(owner.email);
    expect(first).toContain("updated 1");
    expect(first).toContain("Categories set by hand were left unchanged.");

    const again = await db.transaction.findMany({ where: { userId: owner.id } });
    const byRef = (ref: string) => again.find((t) => t.reference === ref)!;
    expect(byRef("R4")).toMatchObject({ category: "Fees", subcategory: "Refund", classificationSource: "rule", merchantName: "Bank charges" });
    expect(byRef("R3")).toMatchObject({ category: "Food", subcategory: "Groceries", classificationSource: "user" });
    expect(byRef("R2")).toMatchObject({ category: "Own transfer", classificationSource: "pair" });
    expect(await db.transaction.findFirstOrThrow({ where: { id: otherReversal.id } })).toMatchObject({ category: "Fees", subcategory: null });

    expect(runRecategorize(owner.email)).toContain("updated 0");
  });

  it("refuses to run without an email", () => {
    expect(() => execFileSync(path.join(ROOT, "node_modules/.bin/tsx"), ["src/scripts/recategorize.ts"], {
      cwd: ROOT, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    })).toThrow(/you@example.com/);
  });
});

describe("re-import fills rows that were not stored", () => {
  const header = ["Guaranty Trust Bank", "Currency: NGN", "Account No,0123456789", "Trans. Date,Reference,Debits,Credits,Balance,Remarks"];
  const salary = "01-Sep-2026,R1,,100000.00,100000.00,SALARY FROM ACME";
  const shop = "02-Sep-2026,R2,5000.00,,95000.00,SHOPRITE LEKKI";
  const uber = "03-Sep-2026,R3,2000.00,,93000.00,UBER TRIP";

  it("adds the rows a later statement has and does not duplicate the ones already imported", async () => {
    const user = await db.user.create({ data: { email: "refill@test.dev" } });
    const partial = await importStatement(user.id, { name: "partial.csv", bytes: Buffer.from([...header, salary, uber].join("\n")) });
    expect(partial).toMatchObject({ created: 2, duplicates: 0 });

    const full = await importStatement(user.id, { name: "full.csv", bytes: Buffer.from([...header, salary, shop, uber].join("\n")) });
    expect(full).toMatchObject({ created: 1, duplicates: 2 });
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(3);
    expect(await db.transaction.findFirst({ where: { userId: user.id, reference: "R2" } })).toMatchObject({ amountMinor: 500_000n, category: "Food" });

    const repeat = await importStatement(user.id, { name: "full.csv", bytes: Buffer.from([...header, salary, shop, uber].join("\n")) });
    expect(repeat).toMatchObject({ created: 0, duplicates: 3 });
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(3);
  });

  it("stores a row that failed to parse the first time once a later file has an amount", async () => {
    const user = await db.user.create({ data: { email: "refill-fixed@test.dev" } });
    const broken = await importStatement(user.id, {
      name: "broken.csv",
      bytes: Buffer.from([...header, salary, "02-Sep-2026,R2,N/A,,95000.00,SHOPRITE LEKKI", uber].join("\n")),
    });
    expect(broken.created).toBe(2);
    expect(broken.errors).toHaveLength(1);

    const fixed = await importStatement(user.id, { name: "fixed.csv", bytes: Buffer.from([...header, salary, shop, uber].join("\n")) });
    expect(fixed).toMatchObject({ created: 1, duplicates: 2 });
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(3);
  });
});
