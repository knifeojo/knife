import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { OWN_TRANSFER } from "../categorize";
import { looksLikeDeel } from "./pairing-rules";

export const ADVANCE_PREFIX = "fx-advance:";
export const ADVANCE_PENDING = "unmatched advance";
export const ADVANCE_HELD = "held unmatched";
export const ADVANCE_DEBT = "count as debt";

export interface AdvanceFlag {
  key: string;
  txId: string;
  date: string;
  amount: string;
  examples: string[];
  totalMinor: bigint;
}

function isDeelAdvanceNarration(description: string, type: string): boolean {
  if (!looksLikeDeel(description)) return false;
  const d = description.toLowerCase();
  if (/fee/.test(d)) return false;
  if (type === "CREDIT") return /advance/.test(d);
  return /repay|advance/.test(d);
}

/**
 * Unmatched Deel salary advances must not sit in income or spending. Relabel them as
 * Own transfer and flag in Review until the owner confirms.
 */
export async function scanUnmatchedAdvances(userId: string): Promise<number> {
  const rows = await db.transaction.findMany({
    where: { userId, transferPairId: null },
    select: { id: true, type: true, amountMinor: true, currency: true, description: true, category: true, subcategory: true, classificationSource: true },
  });
  const hits = rows.filter((r) => isDeelAdvanceNarration(r.description, r.type)
    && r.classificationSource !== "user"
    && (r.category === "Debt" || (r.category === OWN_TRANSFER && r.subcategory === "Unpaired advance")));
  let n = 0;
  for (const h of hits) {
    if (h.category !== OWN_TRANSFER || h.subcategory !== "Unpaired advance") {
      await db.transaction.update({
        where: { id: h.id },
        data: {
          category: OWN_TRANSFER,
          subcategory: "Unpaired advance",
          classificationSource: "rule",
          classificationConfidence: 0.7,
        },
      });
    }
    const pattern = `${ADVANCE_PREFIX}${h.id}`;
    const existing = await db.merchantAlias.findFirst({ where: { userId, pattern }, select: { subcategory: true } });
    if (existing?.subcategory === ADVANCE_HELD || existing?.subcategory === ADVANCE_DEBT) continue;
    await db.merchantAlias.upsert({
      where: { userId_pattern: { userId, pattern } },
      update: { subcategory: ADVANCE_PENDING, canonicalName: "Unmatched Deel advance" },
      create: { userId, pattern, canonicalName: "Unmatched Deel advance", category: null, subcategory: ADVANCE_PENDING },
    });
    n++;
  }
  return n;
}

export async function listPendingAdvances(userId: string): Promise<AdvanceFlag[]> {
  const aliases = await db.merchantAlias.findMany({
    where: { userId, pattern: { startsWith: ADVANCE_PREFIX }, subcategory: ADVANCE_PENDING },
  });
  const out: AdvanceFlag[] = [];
  for (const alias of aliases) {
    const txId = alias.pattern.slice(ADVANCE_PREFIX.length);
    const tx = await db.transaction.findFirst({
      where: { userId, id: txId },
      select: { id: true, amountMinor: true, currency: true, transactionDate: true, description: true },
    });
    if (!tx) continue;
    out.push({
      key: alias.pattern,
      txId: tx.id,
      date: tx.transactionDate.toISOString().slice(0, 10),
      amount: formatMoney(tx.amountMinor, tx.currency),
      examples: [tx.description.replace(/\s+/g, " ").trim()],
      totalMinor: tx.amountMinor,
    });
  }
  return out;
}

export async function resolveAdvance(userId: string, key: string, value: "hold" | "debt"): Promise<number> {
  if (!key.startsWith(ADVANCE_PREFIX)) return 0;
  const txId = key.slice(ADVANCE_PREFIX.length);
  if (value === "debt") {
    const tx = await db.transaction.findFirst({ where: { userId, id: txId }, select: { type: true } });
    if (tx) {
      await db.transaction.update({
        where: { id: txId },
        data: {
          category: "Debt",
          subcategory: tx.type === "CREDIT" ? "Loan proceeds" : "Loan repayment",
          classificationSource: "user",
          classificationConfidence: 1,
        },
      });
    }
  }
  await db.merchantAlias.upsert({
    where: { userId_pattern: { userId, pattern: key } },
    update: { subcategory: value === "debt" ? ADVANCE_DEBT : ADVANCE_HELD },
    create: { userId, pattern: key, canonicalName: key, category: null, subcategory: value === "debt" ? ADVANCE_DEBT : ADVANCE_HELD },
  });
  return 1;
}
