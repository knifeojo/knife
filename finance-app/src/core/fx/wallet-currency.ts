import { db } from "@/lib/db";
import { looksLikeCadNotUsd } from "./guard";

export const WALLET_PREFIX = "fx-wallet:";
export const WALLET_CAD_GUESS = "looks-like-CAD";
export const WALLET_CAD_CONFIRMED = "confirmed-CAD";
export const WALLET_CAD_DISMISSED = "not-CAD";

const CAD_WALLET_LINE = /(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\s*CAD\s+debited from CAD wallet/i;

export interface WalletGuess {
  key: string;
  accountId: string;
  label: string;
  guessed: string;
  current: string;
  examples: string[];
  totalMinor: bigint;
}

export function cadPrefix(value: string | null | undefined): boolean {
  return !!value && /\bCA[A-Z0-9]/i.test(value);
}

export function cadWalletLineEvidence(
  rows: { description: string; amountMinor: bigint; currency: string }[],
): boolean {
  return rows.some((r) => {
    const m = r.description.match(CAD_WALLET_LINE);
    if (!m) return false;
    const minor = BigInt(m[1].replace(/,/g, "")) * 100n + BigInt(m[2]);
    return minor === r.amountMinor;
  });
}

export function cadLandingEvidence(
  rates: number[],
  usdMonthly?: number,
  cadMonthly?: number,
): boolean {
  if (!rates.length) return false;
  const hits = rates.filter((r) => looksLikeCadNotUsd(r, usdMonthly, cadMonthly));
  return hits.length >= 1 && hits.length >= Math.ceil(rates.length / 2);
}

export async function listPendingWalletGuesses(userId: string): Promise<WalletGuess[]> {
  const aliases = await db.merchantAlias.findMany({
    where: { userId, pattern: { startsWith: WALLET_PREFIX }, subcategory: WALLET_CAD_GUESS },
  });
  const out: WalletGuess[] = [];
  for (const alias of aliases) {
    const accountId = alias.pattern.slice(WALLET_PREFIX.length);
    const account = await db.account.findFirst({ where: { userId, id: accountId } });
    if (!account || account.currency === "CAD") continue;
    const samples = await db.transaction.findMany({
      where: { userId, accountId },
      select: { description: true, amountMinor: true },
      take: 4,
      orderBy: { transactionDate: "desc" },
    });
    out.push({
      key: alias.pattern,
      accountId,
      label: `${account.institution} ${account.maskedAccountNumber}`,
      guessed: "CAD",
      current: account.currency,
      examples: samples.map((s) => s.description.replace(/\s+/g, " ").trim()).slice(0, 4),
      totalMinor: samples.reduce((s, r) => s + r.amountMinor, 0n),
    });
  }
  return out;
}

export async function rememberWalletGuess(userId: string, accountId: string, reason: string): Promise<void> {
  const pattern = `${WALLET_PREFIX}${accountId}`;
  const existing = await db.merchantAlias.findFirst({ where: { userId, pattern }, select: { subcategory: true } });
  if (existing?.subcategory === WALLET_CAD_CONFIRMED || existing?.subcategory === WALLET_CAD_DISMISSED) return;
  await db.merchantAlias.upsert({
    where: { userId_pattern: { userId, pattern } },
    update: { subcategory: WALLET_CAD_GUESS, canonicalName: reason.slice(0, 80) },
    create: { userId, pattern, canonicalName: reason.slice(0, 80), category: null, subcategory: WALLET_CAD_GUESS },
  });
}

export async function applyAccountCurrency(userId: string, accountId: string, currency: string): Promise<number> {
  const account = await db.account.findFirst({ where: { userId, id: accountId } });
  if (!account) return 0;
  await db.account.update({ where: { id: accountId }, data: { currency } });
  const res = await db.transaction.updateMany({ where: { userId, accountId }, data: { currency } });
  const pattern = `${WALLET_PREFIX}${accountId}`;
  await db.merchantAlias.upsert({
    where: { userId_pattern: { userId, pattern } },
    update: { subcategory: currency === "CAD" ? WALLET_CAD_CONFIRMED : WALLET_CAD_DISMISSED },
    create: { userId, pattern, canonicalName: `${account.institution} ${currency}`, category: null, subcategory: currency === "CAD" ? WALLET_CAD_CONFIRMED : WALLET_CAD_DISMISSED },
  });
  return res.count;
}

export async function resolveWalletGuess(userId: string, key: string, value: "cad" | "keep"): Promise<number> {
  if (!key.startsWith(WALLET_PREFIX)) return 0;
  const accountId = key.slice(WALLET_PREFIX.length);
  if (value === "keep") {
    await db.merchantAlias.upsert({
      where: { userId_pattern: { userId, pattern: key } },
      update: { subcategory: WALLET_CAD_DISMISSED },
      create: { userId, pattern: key, canonicalName: key, category: null, subcategory: WALLET_CAD_DISMISSED },
    });
    return 0;
  }
  return applyAccountCurrency(userId, accountId, "CAD");
}

export async function scanWalletCurrencyGuesses(
  userId: string,
  usdMonthly?: number,
  cadMonthly?: number,
): Promise<number> {
  const accounts = await db.account.findMany({ where: { userId, currency: { not: "NGN" } } });
  let n = 0;
  for (const account of accounts) {
    if (account.currency === "CAD") continue;
    const txs = await db.transaction.findMany({
      where: { userId, accountId: account.id },
      select: { description: true, amountMinor: true, currency: true, type: true, transferPairId: true, id: true },
    });
    const prefix = cadPrefix(account.maskedAccountNumber) || cadPrefix(account.accountName);
    const line = cadWalletLineEvidence(txs);
    const landings: number[] = [];
    for (const tx of txs.filter((t) => t.type === "DEBIT" && t.transferPairId)) {
      const partner = await db.transaction.findFirst({
        where: { userId, id: tx.transferPairId! },
        select: { amountMinor: true, currency: true },
      });
      if (partner?.currency === "NGN" && tx.amountMinor > 0n) {
        landings.push(Number(partner.amountMinor) / Number(tx.amountMinor));
      }
    }
    const rateHit = cadLandingEvidence(landings, usdMonthly, cadMonthly);
    if (!prefix && !line && !rateHit) continue;
    const reason = prefix ? "Wallet id looks like CAD" : line ? "CAD wallet funding lines" : "Landing rates look like CAD";
    await rememberWalletGuess(userId, account.id, reason);
    n++;
  }
  return n;
}

