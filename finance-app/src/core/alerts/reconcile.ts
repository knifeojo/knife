import { db } from "@/lib/db";
import { ALERT_SOURCE_TYPES } from "./types";

const ALERT_SOURCES = [...ALERT_SOURCE_TYPES];

/**
 * After a statement covers [from, to] for an account: flag alerts with no statement row
 * and statement rows with no alert. Statement remains the source of truth (rows are linked, not copied).
 */
export async function reconcileAlertsVsStatement(
  userId: string,
  accountId: string,
  from: Date,
  to: Date,
): Promise<{ alertOnly: number; statementOnly: number }> {
  const firstAlert = await db.transaction.findFirst({
    where: {
      userId,
      accountId,
      OR: [
        { source: { in: [...ALERT_SOURCES] } },
        { sources: { some: { source: { in: [...ALERT_SOURCES] } } } },
      ],
    },
    orderBy: { transactionDate: "asc" },
    select: { transactionDate: true },
  });
  // Statement history usually starts before alerts do. Only the alert-tracked window is compared,
  // so a 2025 statement row is not flagged just because SMS started in 2026.
  const alertFrom = firstAlert?.transactionDate ?? null;
  const rows = await db.transaction.findMany({
    where: {
      userId,
      accountId,
      transactionDate: { gte: alertFrom && alertFrom > from ? alertFrom : from, lte: to },
    },
    include: { sources: true },
  });
  let alertOnly = 0;
  let statementOnly = 0;
  if (!alertFrom) {
    await db.account.update({
      where: { id: accountId },
      data: { statementCoveredFrom: from, statementCoveredTo: to },
    });
    return { alertOnly: 0, statementOnly: 0 };
  }
  for (const row of rows) {
    const kinds = new Set(row.sources.map((s) => s.source));
    kinds.add(row.source);
    const hasAlert = [...kinds].some((s) => ALERT_SOURCES.includes(s as (typeof ALERT_SOURCES)[number]));
    const hasStatement = kinds.has("statement");
    if (hasAlert && !hasStatement) {
      const exists = await db.reconFlag.findFirst({
        where: { userId, transactionId: row.id, kind: "alert_without_statement", status: "open" },
      });
      if (!exists) {
        await db.reconFlag.create({
          data: {
            userId,
            accountId,
            transactionId: row.id,
            kind: "alert_without_statement",
            detail: "Alert has no matching statement row in the imported period (reversal, missing row, or parse miss).",
          },
        });
        alertOnly++;
      }
    } else if (hasStatement && !hasAlert) {
      const exists = await db.reconFlag.findFirst({
        where: { userId, transactionId: row.id, kind: "statement_without_alert", status: "open" },
      });
      if (!exists) {
        await db.reconFlag.create({
          data: {
            userId,
            accountId,
            transactionId: row.id,
            kind: "statement_without_alert",
            detail: "Statement row has no email or SMS alert.",
          },
        });
        statementOnly++;
      }
    }
  }
  await db.account.update({
    where: { id: accountId },
    data: { statementCoveredFrom: from, statementCoveredTo: to },
  });
  return { alertOnly, statementOnly };
}

export async function dismissReconFlag(userId: string, id: string): Promise<void> {
  await db.reconFlag.updateMany({ where: { id, userId, status: "open" }, data: { status: "dismissed" } });
}
