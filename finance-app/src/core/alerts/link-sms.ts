import { db } from "@/lib/db";
import { lagosDay, lagosDayDelta, statementCoversDate } from "../dedup";

export interface SmsStatementLink {
  userId: string;
  smsId: string;
  statementId: string;
  statementSourceTransactionId: string;
  date: string;
  amountMinor: bigint;
  type: string;
}

/** Date, direction and amount only. No narration, names or account numbers. */
export function formatLinkLine(link: Pick<SmsStatementLink, "date" | "type" | "amountMinor">): string {
  return `${link.date} ${link.type} ${link.amountMinor}`;
}

function hasSource(row: { source: string; sources: { source: string }[] }, source: string): boolean {
  return row.source === source || row.sources.some((s) => s.source === source);
}

/**
 * SMS rows that now match exactly one statement row which does not already have an SMS.
 * A statement row is used at most once. Coverage must already be set (see backfillStatementCoverage).
 */
export async function planSmsStatementLinks(userId?: string): Promise<SmsStatementLink[]> {
  const smsRows = await db.transaction.findMany({
    where: { ...(userId ? { userId } : {}), OR: [{ source: "sms" }, { sources: { some: { source: "sms" } } }] },
    include: { sources: { select: { source: true } }, account: { select: { statementCoveredFrom: true, statementCoveredTo: true } } },
    orderBy: [{ transactionDate: "asc" }, { id: "asc" }],
  });
  const usedStatements = new Set<string>();
  const links: SmsStatementLink[] = [];
  for (const sms of smsRows) {
    if (hasSource(sms, "statement")) continue;
    if (!statementCoversDate(sms.account.statementCoveredFrom, sms.account.statementCoveredTo, sms.transactionDate)) continue;
    const statements = await db.transaction.findMany({
      where: {
        userId: sms.userId,
        accountId: sms.accountId,
        amountMinor: sms.amountMinor,
        type: sms.type,
        currency: sms.currency,
        id: { not: sms.id },
        OR: [{ source: "statement" }, { sources: { some: { source: "statement" } } }],
      },
      include: { sources: { select: { source: true } } },
    });
    const open = statements.filter((row) => {
      if (usedStatements.has(row.id) || hasSource(row, "sms")) return false;
      return lagosDayDelta(row.transactionDate, sms.transactionDate) <= 1;
    });
    if (open.length !== 1) continue;
    const statement = open[0];
    usedStatements.add(statement.id);
    links.push({
      userId: sms.userId,
      smsId: sms.id,
      statementId: statement.id,
      statementSourceTransactionId: statement.sourceTransactionId,
      date: lagosDay(sms.transactionDate),
      amountMinor: sms.amountMinor,
      type: sms.type,
    });
  }
  return links;
}

/** Moves the statement observation onto the SMS row and deletes the extra ledger row. */
export async function applySmsStatementLinks(links: SmsStatementLink[]): Promise<number> {
  let applied = 0;
  for (const link of links) {
    const still = await db.transaction.findUnique({ where: { id: link.smsId }, include: { sources: { select: { source: true } } } });
    const statement = await db.transaction.findUnique({ where: { id: link.statementId } });
    if (!still || !statement || hasSource(still, "statement")) continue;
    await db.$transaction(async (tx) => {
      await tx.transactionSource.updateMany({ where: { transactionId: statement.id }, data: { transactionId: still.id, matchType: "fuzzy" } });
      const marker = await tx.transactionSource.findFirst({
        where: { userId: link.userId, source: "statement", sourceTransactionId: statement.sourceTransactionId },
      });
      if (!marker) {
        await tx.transactionSource.create({
          data: {
            userId: link.userId,
            transactionId: still.id,
            source: "statement",
            sourceTransactionId: statement.sourceTransactionId,
            matchType: "fuzzy",
          },
        });
      } else if (marker.transactionId !== still.id) {
        await tx.transactionSource.update({ where: { id: marker.id }, data: { transactionId: still.id, matchType: "fuzzy" } });
      }
      await tx.transaction.delete({ where: { id: statement.id } });
    });
    applied++;
  }
  return applied;
}
