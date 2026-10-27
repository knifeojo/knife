import { db } from "@/lib/db";
import { reconcileAlertsVsStatement } from "./reconcile";

/** Mark statement coverage and flag alert/statement mismatches per account. */
export async function reconcileAfterStatement(userId: string): Promise<void> {
  const accounts = await db.account.findMany({ where: { userId }, select: { id: true } });
  for (const account of accounts) {
    const range = await db.transaction.aggregate({
      where: { userId, accountId: account.id, source: "statement" },
      _min: { transactionDate: true },
      _max: { transactionDate: true },
    });
    if (!range._min.transactionDate || !range._max.transactionDate) continue;
    await reconcileAlertsVsStatement(userId, account.id, range._min.transactionDate, range._max.transactionDate);
  }
}
