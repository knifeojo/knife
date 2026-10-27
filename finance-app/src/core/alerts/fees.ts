import { db } from "@/lib/db";
import { isFeeNarration } from "./types";

const FEE_WINDOW_MS = 90_000;

/** Link a fee/VAT/stamp-duty row to the adjacent transfer (same account, same minute). */
export async function linkAdjacentFee(userId: string, transactionId: string): Promise<string | undefined> {
  const tx = await db.transaction.findFirst({ where: { id: transactionId, userId } });
  if (!tx || tx.feeOfId || !isFeeNarration(tx.description)) return undefined;

  const parent = await db.transaction.findFirst({
    where: {
      userId,
      accountId: tx.accountId,
      id: { not: tx.id },
      type: tx.type,
      feeOfId: null,
      transactionDate: {
        gte: new Date(tx.transactionDate.getTime() - FEE_WINDOW_MS),
        lte: new Date(tx.transactionDate.getTime() + FEE_WINDOW_MS),
      },
      NOT: { description: { contains: "Commission" } },
    },
    orderBy: [{ amountMinor: "desc" }],
  });
  if (!parent || isFeeNarration(parent.description)) return undefined;
  if (parent.amountMinor <= tx.amountMinor) return undefined;

  await db.transaction.update({
    where: { id: tx.id },
    data: { feeOfId: parent.id, category: "Fees", subcategory: tx.subcategory ?? "Bank charges", classificationSource: "rule", classificationConfidence: 0.95 },
  });
  return parent.id;
}
