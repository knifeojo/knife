import { db } from "@/lib/db";
import { lagosDay } from "./rates";

const BASE = "NGN";

/** Same or next Lagos calendar day: the window the owner’s own wallet-to-bank payouts settle in. */
function sameOrNextDay(a: Date, b: Date): boolean {
  const da = lagosDay(a);
  const db_ = lagosDay(b);
  const gap = Math.abs(Date.parse(`${da}T00:00:00Z`) - Date.parse(`${db_}T00:00:00Z`)) / 86400_000;
  return gap <= 1;
}

/**
 * When a foreign debit is paired with an NGN credit (the owner’s own conversion), store
 * rate = NGN received / foreign sent (fees included) as source "realised".
 */
export async function storeRealisedRates(userId: string, pairIds: { debitId: string; creditId: string }[]): Promise<number> {
  if (!pairIds.length) return 0;
  const ids = pairIds.flatMap((p) => [p.debitId, p.creditId]);
  const rows = await db.transaction.findMany({
    where: { userId, id: { in: ids } },
    select: { id: true, type: true, amountMinor: true, currency: true, transactionDate: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  let stored = 0;
  for (const p of pairIds) {
    const debit = byId.get(p.debitId);
    const credit = byId.get(p.creditId);
    if (!debit || !credit || debit.amountMinor <= 0n || credit.amountMinor <= 0n) continue;
    if (!sameOrNextDay(debit.transactionDate, credit.transactionDate)) continue;
    const foreign = debit.currency !== BASE ? debit : credit.currency !== BASE ? credit : undefined;
    const naira = debit.currency === BASE ? debit : credit.currency === BASE ? credit : undefined;
    if (!foreign || !naira || foreign.currency === naira.currency) continue;
    const rate = Number(naira.amountMinor) / Number(foreign.amountMinor);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const date = lagosDay(naira.transactionDate);
    await db.fxRate.upsert({
      where: {
        userId_date_base_quote_source: {
          userId, date, base: foreign.currency, quote: BASE, source: "realised",
        },
      },
      create: { userId, date, base: foreign.currency, quote: BASE, rate, source: "realised" },
      update: { rate },
    });
    stored++;
  }
  return stored;
}

/** A source-quoted NGN proceeds (Deel withdrawal) becomes a realised rate before the bank credit arrives. */
export async function storeQuotedRate(
  userId: string,
  tx: { amountMinor: bigint; currency: string; transactionDate: Date; fxQuoteCurrency?: string | null; fxQuoteMinor?: bigint | null },
): Promise<void> {
  if (!tx.fxQuoteMinor || tx.fxQuoteMinor <= 0n || tx.amountMinor <= 0n) return;
  if (tx.fxQuoteCurrency !== BASE || tx.currency === BASE) return;
  const rate = Number(tx.fxQuoteMinor) / Number(tx.amountMinor);
  if (!Number.isFinite(rate) || rate <= 0) return;
  const date = lagosDay(tx.transactionDate);
  await db.fxRate.upsert({
    where: { userId_date_base_quote_source: { userId, date, base: tx.currency, quote: BASE, source: "realised" } },
    create: { userId, date, base: tx.currency, quote: BASE, rate, source: "realised" },
    update: { rate },
  });
}
