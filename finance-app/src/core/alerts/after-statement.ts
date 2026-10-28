import { db } from "@/lib/db";
import { reconcileAlertsVsStatement } from "./reconcile";

export interface ReconcileScope {
  accountIds: string[];
  from: Date;
  to: Date;
}

/**
 * Mark statement coverage and flag alert/statement mismatches.
 * With a scope, only those accounts and that date range are checked. Callers that omit it
 * still walk every account's full statement span.
 */
export async function reconcileAfterStatement(userId: string, scope?: ReconcileScope): Promise<void> {
  if (scope) {
    for (const accountId of scope.accountIds) await reconcileAlertsVsStatement(userId, accountId, scope.from, scope.to);
    return;
  }
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
