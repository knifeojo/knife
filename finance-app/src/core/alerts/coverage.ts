import { db } from "@/lib/db";

/**
 * Sets statementCoveredFrom/To from the earliest and latest transaction whose own source is
 * "statement". Does not reconcile, so it does not open review flags for old statement rows.
 * Safe to run again: an account whose span is already those dates is left untouched.
 */
export async function backfillStatementCoverage(): Promise<{ accounts: number; updated: number }> {
  const grouped = await db.transaction.groupBy({
    by: ["accountId"],
    where: { source: "statement" },
    _min: { transactionDate: true },
    _max: { transactionDate: true },
  });
  let updated = 0;
  for (const row of grouped) {
    const from = row._min.transactionDate;
    const to = row._max.transactionDate;
    if (!from || !to) continue;
    const account = await db.account.findUnique({
      where: { id: row.accountId },
      select: { statementCoveredFrom: true, statementCoveredTo: true },
    });
    if (!account) continue;
    if (account.statementCoveredFrom?.getTime() === from.getTime() && account.statementCoveredTo?.getTime() === to.getTime()) continue;
    await db.account.update({
      where: { id: row.accountId },
      data: { statementCoveredFrom: from, statementCoveredTo: to },
    });
    updated++;
  }
  return { accounts: grouped.length, updated };
}
