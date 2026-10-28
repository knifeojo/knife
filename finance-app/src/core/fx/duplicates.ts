import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { lagosDay } from "./rates";

export const DUP_PREFIX = "fx-dup:";
export const DUP_PENDING = "possible duplicate";
export const DUP_KEPT = "kept both";
export const DUP_DISMISSED = "dismissed duplicate";

export interface DuplicateFlag {
  key: string;
  creditIds: string[];
  debitIds: string[];
  date: string;
  amount: string;
  examples: string[];
  totalMinor: bigint;
}

function normalizeFormat(description: string): string {
  return description.toUpperCase().replace(/[0-9]+/g, "").replace(/[^A-Z]+/g, " ").replace(/\s+/g, " ").trim();
}

function adjacent(a: Date, b: Date): boolean {
  return Math.abs(Date.parse(`${lagosDay(a)}T00:00:00Z`) - Date.parse(`${lagosDay(b)}T00:00:00Z`)) / 86400_000 <= 1;
}

function dupKey(a: string, b: string): string {
  return a < b ? `${DUP_PREFIX}${a}:${b}` : `${DUP_PREFIX}${b}:${a}`;
}

function parseDupKey(key: string): { a: string; b: string } | null {
  if (!key.startsWith(DUP_PREFIX)) return null;
  const rest = key.slice(DUP_PREFIX.length);
  const cut = rest.indexOf(":");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { a: rest.slice(0, cut), b: rest.slice(cut + 1) };
}

/**
 * Same amount on the same account, same or next Lagos day, two description formats.
 * The running balance only moved once (or balances are missing): flag, do not delete.
 */
export function findPossibleDuplicates<T extends {
  id: string;
  accountId: string;
  type: string;
  amountMinor: bigint;
  currency: string;
  transactionDate: Date;
  description: string;
  balanceAfterMinor?: bigint | null;
  transferPairId?: string | null;
}>(rows: T[]): { a: T; b: T }[] {
  const out: { a: T; b: T }[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (a.accountId !== b.accountId || a.type !== b.type || a.currency !== b.currency) continue;
      if (a.amountMinor !== b.amountMinor || a.amountMinor <= 0n) continue;
      if (!adjacent(a.transactionDate, b.transactionDate)) continue;
      if (normalizeFormat(a.description) === normalizeFormat(b.description)) continue;
      if (!singleMovement(a, b)) continue;
      out.push({ a, b });
    }
  }
  return out;
}

function singleMovement(
  a: { transactionDate: Date; amountMinor: bigint; balanceAfterMinor?: bigint | null },
  b: { transactionDate: Date; amountMinor: bigint; balanceAfterMinor?: bigint | null },
): boolean {
  if (a.balanceAfterMinor == null || b.balanceAfterMinor == null) return true;
  const [first, second] = a.transactionDate <= b.transactionDate ? [a, b] : [b, a];
  const delta = second.balanceAfterMinor! - first.balanceAfterMinor!;
  const abs = delta < 0n ? -delta : delta;
  // Two real credits of X would move the printed balance by another X. A reprint does not.
  return abs < first.amountMinor;
}

export async function scanDuplicateFlags(userId: string): Promise<number> {
  const rows = await db.transaction.findMany({
    where: { userId },
    select: {
      id: true, accountId: true, type: true, amountMinor: true, currency: true,
      transactionDate: true, description: true, balanceAfterMinor: true, transferPairId: true,
    },
  });
  const credits = rows.filter((r) => r.type === "CREDIT" && r.currency === "NGN");
  const pairs = findPossibleDuplicates(credits);
  let n = 0;
  for (const { a, b } of pairs) {
    const pattern = dupKey(a.id, b.id);
    const existing = await db.merchantAlias.findFirst({ where: { userId, pattern }, select: { subcategory: true } });
    if (existing?.subcategory === DUP_KEPT || existing?.subcategory === DUP_DISMISSED) continue;
    const label = `Possible duplicate ${formatMoney(a.amountMinor, a.currency)}`.slice(0, 80);
    await db.merchantAlias.upsert({
      where: { userId_pattern: { userId, pattern } },
      update: { subcategory: DUP_PENDING, canonicalName: label },
      create: { userId, pattern, canonicalName: label, category: null, subcategory: DUP_PENDING },
    });
    n++;
  }
  return n;
}

export async function listPendingDuplicates(userId: string): Promise<DuplicateFlag[]> {
  const aliases = await db.merchantAlias.findMany({
    where: { userId, pattern: { startsWith: DUP_PREFIX }, subcategory: DUP_PENDING },
  });
  const out: DuplicateFlag[] = [];
  for (const alias of aliases) {
    const ids = parseDupKey(alias.pattern);
    if (!ids) continue;
    const credits = await db.transaction.findMany({
      where: { userId, id: { in: [ids.a, ids.b] } },
      select: { id: true, amountMinor: true, currency: true, transactionDate: true, description: true, transferPairId: true },
    });
    if (credits.length < 2) continue;
    const debitIds = credits.map((c) => c.transferPairId).filter((x): x is string => !!x);
    const debits = debitIds.length
      ? await db.transaction.findMany({ where: { userId, id: { in: debitIds } }, select: { id: true, description: true } })
      : [];
    out.push({
      key: alias.pattern,
      creditIds: credits.map((c) => c.id),
      debitIds: debits.map((d) => d.id),
      date: lagosDay(credits[0].transactionDate),
      amount: formatMoney(credits[0].amountMinor, credits[0].currency),
      examples: [...credits, ...debits].map((r) => r.description.replace(/\s+/g, " ").trim()).slice(0, 4),
      totalMinor: credits[0].amountMinor,
    });
  }
  return out;
}

export async function resolveDuplicate(userId: string, key: string, value: "keep" | "dismiss"): Promise<number> {
  const ids = parseDupKey(key);
  if (!ids) return 0;
  const pattern = dupKey(ids.a, ids.b);
  await db.merchantAlias.upsert({
    where: { userId_pattern: { userId, pattern } },
    update: { subcategory: value === "keep" ? DUP_KEPT : DUP_DISMISSED },
    create: { userId, pattern, canonicalName: pattern, category: null, subcategory: value === "keep" ? DUP_KEPT : DUP_DISMISSED },
  });
  return 2;
}
