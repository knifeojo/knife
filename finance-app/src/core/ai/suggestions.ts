import { db } from "@/lib/db";
import { OWN_TRANSFER, categorize, nameTokens, sameName, type UserRule } from "../categorize";
import { loadOwners } from "../ledger";
import { relationshipForLabel, sameIndividual, type Relationship } from "../people-match";
import { buildQuestions, memoOf, type Question } from "../review";
import { pairOwnTransfers, unpairContradicted } from "../transfers";

// AI suggestions in Review. A suggestion changes nothing until the owner confirms it. Confirming
// saves a MerchantAlias rule (the same kind a Review answer saves), so the payee is labelled by the
// rules from then on and never goes back to the AI.

export interface SuggestionGroup {
  /** The suggestion to confirm or dismiss; the action covers the whole group. */
  id: string;
  ids: string[];
  /** Lowercase rule pattern the confirmation will save, when one matches this payee. */
  key?: string;
  display: string;
  type: "DEBIT" | "CREDIT";
  category: string;
  subcategory: string | null;
  reason: string;
  confidence: number;
  model: string;
  count: number;
  totalMinor: bigint;
  currentCategory: string;
  examples: string[];
}

export type QuestionWithSuggestion = Question & {
  aiSuggestion?: SuggestionGroup;
  /** For "Who is <NAME> to you?": the relationship the AI's label implies. A proposal; the owner taps to confirm. */
  aiRelationship?: Relationship;
};

interface TxLite {
  id: string;
  type: string;
  description: string;
  counterparty: string | null;
  merchantName: string | null;
}

/**
 * The rule pattern that, saved as a MerchantAlias, labels this transaction the next time it is
 * imported. Candidates are tried in the order a person would name the payee; each is checked with
 * the real categorizer so a saved rule is never one that fails to match.
 * Undefined when the payee has no usable name: confirming then labels just that one row.
 */
export function rulePatternFor(t: TxLite, owners: string[]): string | undefined {
  const memo = memoOf(t.description);
  // No fallback to the raw narration: "instant payment outward to opay" would label strangers alike.
  const candidates = [t.counterparty, t.merchantName, memo]
    .map((c) => c?.trim().toLowerCase())
    .filter((c): c is string => !!c && c.replace(/[^a-z]/g, "").length >= 3);
  for (const pattern of new Set(candidates)) {
    const probe: UserRule = { pattern, canonicalName: pattern, category: "Other", subcategory: "probe" };
    if (categorize({ description: t.description, type: t.type as "DEBIT" | "CREDIT" }, [probe], owners).source === "user") return pattern;
  }
  return undefined;
}

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Pending suggestions, grouped by payee and proposed label, largest money first. */
export async function suggestionGroups(userId: string): Promise<SuggestionGroup[]> {
  const pending = await db.categorySuggestion.findMany({
    where: { userId, status: "pending", category: { not: null }, transaction: { classificationSource: { notIn: ["user", "pair"] }, transferPairId: null } },
    include: { transaction: { select: { id: true, type: true, description: true, counterparty: true, merchantName: true, amountMinor: true, category: true, subcategory: true } } },
  });
  if (!pending.length) return [];
  const owners = await loadOwners(userId);
  const groups = new Map<string, SuggestionGroup>();
  for (const s of pending) {
    const t = s.transaction;
    const key = rulePatternFor(t, owners);
    const id = `${t.type}|${key ?? t.id}|${s.category}|${s.subcategory ?? ""}`;
    let g = groups.get(id);
    if (!g) {
      g = {
        id: s.id, ids: [], key, display: t.counterparty ?? t.merchantName ?? (key ? titleCase(key) : t.description.slice(0, 48)),
        type: t.type as "DEBIT" | "CREDIT", category: s.category!, subcategory: s.subcategory, reason: s.reason ?? "", confidence: s.confidence ?? 0, model: s.model,
        count: 0, totalMinor: 0n, currentCategory: [t.category, t.subcategory].filter(Boolean).join(" / "), examples: [],
      };
      groups.set(id, g);
    }
    g.ids.push(s.id);
    g.count++;
    g.totalMinor += t.amountMinor;
    if ((s.confidence ?? 0) > g.confidence) {
      g.confidence = s.confidence ?? 0;
      g.reason = s.reason ?? g.reason;
    }
    const narration = t.description.replace(/\s+/g, " ").trim();
    if (g.examples.length < 3 && !g.examples.includes(narration)) g.examples.push(narration);
  }
  return [...groups.values()].sort((a, b) => (b.totalMinor > a.totalMinor ? 1 : b.totalMinor < a.totalMinor ? -1 : b.count - a.count));
}

function matchesQuestion(q: Question, g: SuggestionGroup): boolean {
  if (q.kind === "holder" || q.kind === "conversion" || q.kind === "match" || q.kind === "mispair" || q.kind === "duplicate" || q.kind === "currency" || q.kind === "advance") return false;
  // People questions cover money both ways.
  if (!q.person && (q.kind === "income") !== (g.type === "CREDIT")) return false;
  if (!g.key) return false;
  if (q.person) return q.person.variants.some((v) => v.toLowerCase() === g.key || sameName(v, g.display) || sameIndividual(v, g.display));
  return g.key === q.key || (nameTokens(q.key).length >= 2 && sameName(g.display, q.key));
}

/** Review questions, each with the AI's pick when it has one, plus AI suggestions no question covers. */
export async function reviewWithSuggestions(userId: string): Promise<{ questions: QuestionWithSuggestion[]; suggestions: SuggestionGroup[] }> {
  const [questions, groups] = await Promise.all([buildQuestions(userId), suggestionGroups(userId)]);
  const used = new Set<string>();
  const withAi = questions.map((q) => {
    const g = groups.find((x) => !used.has(x.id) && matchesQuestion(q, x));
    if (!g) return q;
    used.add(g.id);
    const aiRelationship = q.person ? relationshipForLabel(g.category, g.subcategory) : undefined;
    return { ...q, aiSuggestion: g, ...(aiRelationship && { aiRelationship }) };
  });
  return { questions: withAi, suggestions: groups.filter((g) => !used.has(g.id)) };
}

export class SuggestionNotFoundError extends Error {}

/**
 * The owner accepts the AI's label. Saves (or strengthens) the payee rule, labels every matching
 * transaction as the owner's own answer, and resolves the suggestions it covers. Returns rows updated.
 */
export async function confirmSuggestion(userId: string, suggestionId: string): Promise<number> {
  const s = await db.categorySuggestion.findFirst({
    where: { id: suggestionId, userId, status: "pending", category: { not: null } },
    include: { transaction: true },
  });
  if (!s) throw new SuggestionNotFoundError("suggestion not found");
  const t = s.transaction;
  const category = s.category!;
  const subcategory = s.subcategory;
  const owners = await loadOwners(userId);
  const pattern = rulePatternFor(t, owners);

  let ids = [t.id];
  if (pattern) {
    const canonicalName = t.counterparty ?? t.merchantName ?? titleCase(pattern);
    const rule: UserRule = { pattern, canonicalName, category, subcategory };
    await db.merchantAlias.upsert({
      where: { userId_pattern: { userId, pattern } },
      update: { category, subcategory, canonicalName },
      create: { userId, pattern, canonicalName, category, subcategory },
    });
    const rows = await db.transaction.findMany({
      where: { userId, type: t.type, classificationSource: { notIn: ["user", "pair"] }, transferPairId: null },
      select: { id: true, description: true, type: true },
    });
    ids = [...new Set([t.id, ...rows.filter((r) => categorize({ description: r.description, type: r.type as "DEBIT" | "CREDIT" }, [rule], owners).source === "user").map((r) => r.id)])];
  }
  const res = await db.transaction.updateMany({
    where: { userId, id: { in: ids }, classificationSource: { notIn: ["user", "pair"] } },
    data: { category, subcategory, classificationSource: "user", classificationConfidence: 1 },
  });
  const now = new Date();
  await db.categorySuggestion.updateMany({
    where: { userId, status: "pending", transactionId: { in: ids }, category, subcategory },
    data: { status: "confirmed", decidedAt: now },
  });
  await db.categorySuggestion.updateMany({
    where: { userId, status: "pending", transactionId: { in: ids } },
    data: { status: "superseded", decidedAt: now },
  });
  if (category === OWN_TRANSFER) await pairOwnTransfers(userId);
  else await unpairContradicted(userId, ids);
  return res.count;
}

/** "Not right": drops this suggestion and the others in its group. The payee stays in Review's questions. */
export async function dismissSuggestion(userId: string, suggestionId: string): Promise<number> {
  const groups = await suggestionGroups(userId);
  const group = groups.find((g) => g.ids.includes(suggestionId));
  if (!group) {
    const res = await db.categorySuggestion.updateMany({ where: { id: suggestionId, userId, status: "pending" }, data: { status: "dismissed", decidedAt: new Date() } });
    if (!res.count) throw new SuggestionNotFoundError("suggestion not found");
    return res.count;
  }
  const res = await db.categorySuggestion.updateMany({ where: { userId, id: { in: group.ids }, status: "pending" }, data: { status: "dismissed", decidedAt: new Date() } });
  return res.count;
}

/** Counts for Settings. */
export async function suggestionCounts(userId: string): Promise<{ pending: number; confirmed: number; dismissed: number; failed: number }> {
  const rows = await db.categorySuggestion.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } });
  const n = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
  return { pending: n("pending"), confirmed: n("confirmed"), dismissed: n("dismissed"), failed: n("failed") };
}
