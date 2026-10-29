import { db } from "@/lib/db";
import { accountKeyOf } from "./files";

/**
 * One StatementFile per account that already has statement rows but was imported before files were
 * tracked. The hash is `backfill:<accountId>`, so running this again does not insert a second row.
 * It does not re-parse, re-pair, or reconcile.
 */
export async function backfillStatementFiles(): Promise<{ accounts: number; created: number; updated: number }> {
  const accounts = await db.account.findMany({
    select: {
      id: true,
      userId: true,
      institution: true,
      maskedAccountNumber: true,
      currency: true,
      statementCoveredFrom: true,
      statementCoveredTo: true,
    },
  });
  let created = 0;
  let updated = 0;
  let withRows = 0;
  for (const account of accounts) {
    const where = { userId: account.userId, accountId: account.id, source: "statement" };
    const [range, count] = await Promise.all([
      db.transaction.aggregate({ where, _min: { transactionDate: true }, _max: { transactionDate: true } }),
      db.transaction.count({ where }),
    ]);
    const from = account.statementCoveredFrom ?? range._min.transactionDate;
    const to = account.statementCoveredTo ?? range._max.transactionDate;
    if (!from || !to || count === 0) continue;
    withRows++;
    const last4 = account.maskedAccountNumber.replace(/\D/g, "").slice(-4);
    const contentHash = `backfill:${account.id}`;
    const data = {
      fileName: `Earlier statement · ${account.institution}`.slice(0, 160),
      institution: account.institution,
      accountKey: accountKeyOf(account.institution, last4, account.currency),
      accountLast4: last4 || null,
      currency: account.currency,
      periodFrom: from,
      periodTo: to,
      source: "backfill",
      status: "imported",
      transactionCount: count,
      rowsRead: count,
      complete: true,
      bytesStored: false,
    };
    const existing = await db.statementFile.findUnique({ where: { userId_contentHash: { userId: account.userId, contentHash } } });
    if (!existing) {
      await db.statementFile.create({ data: { userId: account.userId, contentHash, ...data } });
      created++;
      continue;
    }
    const same = existing.periodFrom?.getTime() === from.getTime() && existing.periodTo?.getTime() === to.getTime() && existing.transactionCount === count;
    if (same) continue;
    await db.statementFile.update({ where: { id: existing.id }, data });
    updated++;
  }
  return { accounts: withRows, created, updated };
}
