import { db } from "@/lib/db";
import { signedAmount } from "./types";

/** Walk an account's running balances; flag when previous Bal +/- Amt != this Bal. */
export async function scanBalanceGaps(userId: string, accountId: string): Promise<number> {
  const rows = await db.transaction.findMany({
    where: { userId, accountId, balanceAfterMinor: { not: null } },
    orderBy: [{ transactionDate: "asc" }, { amountMinor: "desc" }],
    take: 800,
  });
  let flagged = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev.balanceAfterMinor == null || cur.balanceAfterMinor == null) continue;
    const expected = prev.balanceAfterMinor + signedAmount(cur.type as "DEBIT" | "CREDIT", cur.amountMinor);
    if (expected === cur.balanceAfterMinor) continue;
    const gap = cur.balanceAfterMinor - expected;
    const existing = await db.balanceGap.findUnique({ where: { userId_currentTxId: { userId, currentTxId: cur.id } } });
    if (existing) continue;
    await db.balanceGap.create({
      data: {
        userId,
        accountId,
        previousTxId: prev.id,
        currentTxId: cur.id,
        expectedMinor: expected,
        actualMinor: cur.balanceAfterMinor,
        gapMinor: gap < 0n ? -gap : gap,
        atDate: cur.transactionDate,
      },
    });
    flagged++;
  }
  return flagged;
}

export async function dismissBalanceGap(userId: string, id: string): Promise<void> {
  await db.balanceGap.updateMany({ where: { id, userId, status: "open" }, data: { status: "dismissed" } });
}
