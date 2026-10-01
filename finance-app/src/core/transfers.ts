import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { formatMoney } from "@/lib/money";
import { OWN_TRANSFER, categorize, isSelf } from "./categorize";
import { BANKS } from "./statements";

// Pairs money moving between two of the user's own accounts, so it is neither spending (on the
// sending account) nor income (on the receiving one). Runs after every import.
//
// A pair needs: same user and currency, opposite directions, same amount, different accounts,
// dates within 2 days, AND at least one supporting clue (amount + date alone is too weak: you can
// receive ₦200K from a friend the day you send ₦200K to someone else):
//   - one leg is already known to be your own transfer (your name appears), or
//   - the debit's narration names the receiving account's bank ("... TO OPAY"), or
//   - the credit's narration names the sending account's bank ("Transfer from Guaranty Trust Bank"), or
//   - either side's counterparty is you.

const WINDOW_MS = 2 * 86400_000 + 12 * 3600_000;

// Short codes banks print in narrations, in addition to the full names in BANKS.
const SHORT_CODES: Record<string, RegExp> = {
  GTBank: /\bgtb\b|\bgtco\b|gtbank|guaranty/i,
  "Zenith Bank": /\bzbn\b|zenith/i,
  Moniepoint: /monie ?mfb|moniemf ?b|moniepoint/i,
  "Access Bank": /\babp\b|access/i,
  "First Bank": /\bfbn\b|first ?bank/i,
  "Fidelity Bank": /\bfbp\b|fidelity/i,
  "Wema Bank": /wema|alat/i,
  "Stanbic IBTC": /stanbic/i,
  Kuda: /kuda/i,
  OPay: /\bopay\b/i,
  PalmPay: /palmpay/i,
  "Sterling Bank": /sterling/i,
  UBA: /\buba\b/i,
  FCMB: /\bfcmb\b/i,
};

export function mentionsInstitution(narration: string, institution: string): boolean {
  const short = SHORT_CODES[institution];
  if (short?.test(narration)) return true;
  const full = BANKS.find(([, name]) => name === institution)?.[0];
  return !!full?.test(narration);
}

interface Leg {
  id: string;
  accountId: string;
  institution: string;
  type: string;
  amountMinor: bigint;
  currency: string;
  transactionDate: Date;
  description: string;
  counterparty: string | null;
  category: string;
  classificationSource: string;
}

export interface PairCandidate { debit: Leg; credit: Leg; clue: string }

/** Pure matching: returns one-to-one pairs, closest dates first. */
/**
 * A user label blocks linking only when it says the money went somewhere else (e.g. "Family").
 * Income labels ("Salary") don't: salary moved from your wallet to your bank is still salary, it is
 * just counted once, where it was paid.
 */
function blockedByLabel(l: Leg): boolean {
  return l.classificationSource === "user" && l.category !== OWN_TRANSFER && !(l.type === "CREDIT" && l.category === "Income");
}

export function findPairs(legs: Leg[], owners: string[]): PairCandidate[] {
  const debits = legs.filter((l) => l.type === "DEBIT");
  const credits = legs.filter((l) => l.type === "CREDIT");
  const options: (PairCandidate & { gap: number })[] = [];
  for (const d of debits) {
    for (const c of credits) {
      if (c.accountId === d.accountId || c.currency !== d.currency || c.amountMinor !== d.amountMinor) continue;
      const gap = Math.abs(c.transactionDate.getTime() - d.transactionDate.getTime());
      if (gap > WINDOW_MS) continue;
      // A leg the user labelled as something else (e.g. "Family") is not an own transfer.
      if (blockedByLabel(d) || blockedByLabel(c)) continue;
      const clue =
        d.category === OWN_TRANSFER || c.category === OWN_TRANSFER ? "already own transfer"
        : isSelf(d.counterparty ?? undefined, owners) || isSelf(c.counterparty ?? undefined, owners) ? "your name"
        : mentionsInstitution(d.description, c.institution) ? `debit names ${c.institution}`
        : mentionsInstitution(c.description, d.institution) ? `credit names ${d.institution}`
        : undefined;
      if (clue) options.push({ debit: d, credit: c, clue, gap });
    }
  }
  options.push(...crossCurrencyOptions(debits, credits, owners));
  options.sort((a, b) => a.gap - b.gap);
  const used = new Set<string>();
  const pairs: PairCandidate[] = [];
  for (const o of options) {
    if (used.has(o.debit.id) || used.has(o.credit.id)) continue;
    used.add(o.debit.id);
    used.add(o.credit.id);
    pairs.push({ debit: o.debit, credit: o.credit, clue: o.clue });
  }
  return pairs;
}

/**
 * Own-money conversions between currencies (e.g. CAD wallet -> naira bank account): amounts differ by
 * an exchange rate, so they need stronger evidence: same or next day, the sending side names the
 * receiving bank, and the implied rate agrees (within 2.5%) with the most common rate among candidates.
 * Needs at least 3 consistent candidates, so a single coincidence never pairs.
 */
function crossCurrencyOptions(debits: Leg[], credits: Leg[], owners: string[]): (PairCandidate & { gap: number })[] {
  const raw: (PairCandidate & { gap: number; rate: number; key: string })[] = [];
  for (const d of debits) {
    for (const c of credits) {
      if (c.accountId === d.accountId || c.currency === d.currency) continue;
      if (blockedByLabel(d) || blockedByLabel(c)) continue;
      const gap = Math.abs(c.transactionDate.getTime() - d.transactionDate.getTime());
      if (gap > 36 * 3600_000) continue;
      // The send must point at the receiving bank, or at least not name a DIFFERENT bank.
      const namesOtherBank = Object.keys(SHORT_CODES).some((inst) => inst !== c.institution && mentionsInstitution(d.description, inst));
      const namesReceiver = mentionsInstitution(d.description, c.institution) || (!namesOtherBank && (isSelf(d.counterparty ?? undefined, owners) || d.category === OWN_TRANSFER));
      if (!namesReceiver) continue;
      const rate = Number(c.amountMinor) / Number(d.amountMinor);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      raw.push({ debit: d, credit: c, clue: `converted ${d.currency} to ${c.currency}`, gap, rate, key: `${d.currency}>${c.currency}` });
    }
  }
  const out: (PairCandidate & { gap: number })[] = [];
  for (const key of new Set(raw.map((r) => r.key))) {
    const group = raw.filter((r) => r.key === key);
    // The true conversions share one rate; wrong combinations scatter. Take the densest rate cluster
    // (the rate with the most distinct sends within 2.5% of it), not the median of everything.
    const near = (a: number, b: number) => Math.abs(a - b) / b <= 0.025;
    let median = 0, best = 0;
    for (const r of group) {
      const n = new Set(group.filter((x) => near(x.rate, r.rate)).map((x) => x.debit.id)).size;
      if (n > best) { best = n; median = r.rate; }
    }
    const consistent = group.filter((r) => near(r.rate, median));
    if (new Set(consistent.map((r) => r.debit.id)).size < 3) continue;
    // Prefer the closest rate, then the closest date, so each leg finds its true partner.
    out.push(...consistent.map((r) => ({ debit: r.debit, credit: r.credit, clue: r.clue, gap: r.gap + Math.abs(r.rate - median) / median * 86400_000 })));
  }
  return out;
}

/** Finds and links own-account transfer pairs for a user. Returns how many new pairs were made. */
export async function pairOwnTransfers(userId: string): Promise<number> {
  const accounts = await db.account.findMany({ where: { userId } });
  if (accounts.length < 2) return 0;
  const owners = [...new Set(accounts.map((a) => a.holderName).filter((x): x is string => !!x))];
  const inst = new Map(accounts.map((a) => [a.id, a.institution]));
  const rows = await db.transaction.findMany({
    where: { userId, transferPairId: null },
    select: { id: true, accountId: true, type: true, amountMinor: true, currency: true, transactionDate: true, description: true, counterparty: true, category: true, classificationSource: true },
  });
  const legs: Leg[] = rows.map((r) => ({ ...r, institution: inst.get(r.accountId) ?? "" }));
  const pairs = findPairs(legs, owners);
  for (const p of pairs) {
    // Link both legs. The user's own labels are kept (e.g. "Salary"): totals skip linked legs, so the
    // label stays meaningful without double counting. Unlabelled legs show as an own transfer.
    const data = (leg: Leg, other: string) =>
      leg.classificationSource === "user"
        ? { transferPairId: other }
        : { transferPairId: other, category: OWN_TRANSFER, subcategory: p.debit.currency !== p.credit.currency ? "Currency conversion" : "Between own accounts", classificationSource: "pair", classificationConfidence: 0.95 };
    await db.$transaction([
      db.transaction.update({ where: { id: p.debit.id }, data: data(p.debit, p.credit.id) }),
      db.transaction.update({ where: { id: p.credit.id }, data: data(p.credit, p.debit.id) }),
    ]);
  }
  if (pairs.length) log.info("transfers.paired", { userId, pairs: pairs.length });
  return pairs.length;
}

export interface ConversionEvidence {
  name: string; // the payee the user labelled as income, e.g. "Pesapeer Ltd"
  rows: { date: string; sent: string; received: string; creditId: string }[];
  totalReceivedMinor: bigint;
}

/**
 * Conversions blocked only by the user's own "income" label: e.g. naira credits labelled Salary that
 * match CAD sends from the user's wallet at a consistent rate. Used to ASK the user, never to relabel.
 */
export async function suspectedConversions(userId: string): Promise<ConversionEvidence[]> {
  const accounts = await db.account.findMany({ where: { userId } });
  if (new Set(accounts.map((a) => a.currency)).size < 2) return [];
  const owners = [...new Set(accounts.map((a) => a.holderName).filter((x): x is string => !!x))];
  const inst = new Map(accounts.map((a) => [a.id, a.institution]));
  const rows = await db.transaction.findMany({
    where: { userId, transferPairId: null },
    select: { id: true, accountId: true, type: true, amountMinor: true, currency: true, transactionDate: true, description: true, counterparty: true, merchantName: true, category: true, subcategory: true, classificationSource: true },
  });
  // Relax only user INCOME labels on credits, to see what they are hiding.
  const legs: Leg[] = rows.map((r) => ({
    ...r,
    institution: inst.get(r.accountId) ?? "",
    classificationSource: r.type === "CREDIT" && r.classificationSource === "user" && r.category === "Income" ? "default" : r.classificationSource,
  }));
  const userIncome = new Set(rows.filter((r) => r.type === "CREDIT" && r.classificationSource === "user" && r.category === "Income").map((r) => r.id));
  const pairs = findPairs(legs, owners).filter((p) => p.debit.currency !== p.credit.currency && userIncome.has(p.credit.id));
  const byName = new Map<string, ConversionEvidence>();
  const fmt = (m: bigint, c: string) => formatMoney(m, c);
  for (const p of pairs) {
    const r = rows.find((x) => x.id === p.credit.id)!;
    const name = r.merchantName ?? r.counterparty ?? "Unnamed";
    const e = byName.get(name) ?? { name, rows: [], totalReceivedMinor: 0n };
    e.rows.push({
      date: new Date(p.credit.transactionDate.getTime() + 3600_000).toISOString().slice(0, 10),
      sent: fmt(p.debit.amountMinor, p.debit.currency),
      received: fmt(p.credit.amountMinor, p.credit.currency),
      creditId: p.credit.id,
    });
    e.totalReceivedMinor += p.credit.amountMinor;
    byName.set(name, e);
  }
  return [...byName.values()].map((e) => ({ ...e, rows: e.rows.sort((a, b) => a.date.localeCompare(b.date)) }));
}

/**
 * When the user labels a paired leg as something other than an own transfer, the pairing is wrong (or
 * at least contested): unpair both legs and recategorize the partner from the rules. A conversion
 * question will then show the evidence and let the user settle it.
 */
export async function unpairContradicted(userId: string, ids: string[]): Promise<void> {
  const legs = (await db.transaction.findMany({ where: { userId, id: { in: ids }, transferPairId: { not: null }, category: { not: OWN_TRANSFER } } }))
    .filter((l) => !(l.type === "CREDIT" && l.category === "Income")); // income labels don't contradict a link
  for (const leg of legs) {
    const partner = await db.transaction.findFirst({ where: { userId, id: leg.transferPairId! } });
    await db.transaction.update({ where: { id: leg.id }, data: { transferPairId: null } });
    if (partner && partner.classificationSource === "pair") {
      const c = categorize({ description: partner.description, type: partner.type as "DEBIT" | "CREDIT" });
      await db.transaction.update({
        where: { id: partner.id },
        data: { transferPairId: null, category: c.category, subcategory: c.subcategory ?? null, classificationSource: c.source, classificationConfidence: c.confidence },
      });
    } else if (partner) {
      await db.transaction.update({ where: { id: partner.id }, data: { transferPairId: null } });
    }
  }
}
