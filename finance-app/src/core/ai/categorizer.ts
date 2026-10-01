import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { ALL_CATEGORIES, OWN_TRANSFER, sameName } from "../categorize";
import type { Classifier } from "../eval";
import { buildProfile, profileText } from "../profile";
import { SKIPPED, memoOf } from "../review";
import type { Classification, TransactionType } from "../types";
import { FALLBACK, MODEL, aiAllowed, anthropic, redactNarration } from "./client";

// AI fallback for transactions the rules could not place confidently.
// The model sees: redacted narration, direction, extracted payee and memo, the user's own labels as
// examples, and their profile. It returns ONLY category/subcategory/confidence per row (schema-enforced).
// It never sees or returns amounts, dates or balances, so it cannot change them.

export interface AiRow {
  id: string;
  type: TransactionType;
  narration: string;
  payee?: string;
  memo?: string;
}

export interface AiSuggestion {
  id: string;
  category: string;
  subcategory: string | null;
  confidence: number;
  reason: string;
}

export interface AiContext {
  profile: string;
  examples: { name: string; category: string; subcategory: string | null }[];
}

/** The model call, injectable so tests and evals can run without a network. */
export type CategorizeLLM = (rows: AiRow[], ctx: AiContext) => Promise<AiSuggestion[]>;

const SuggestionSchema = z.object({
  suggestions: z.array(
    z.object({
      id: z.string(),
      category: z.enum(ALL_CATEGORIES as [string, ...string[]]),
      subcategory: z.string().nullable(),
      confidence: z.number(),
      reason: z.string(),
    }),
  ),
});

const SYSTEM = `You categorize Nigerian bank transactions for one person's personal finance app.
Choose the single best category for each row from the allowed list. Use the person's own labels and profile as strong evidence: if a payee matches someone they labelled, follow their label. Memos people type ("MONTHLY", "BAL", "LUNCH", "DADDYS AC") and trade words in payee names ("COUTURE", "INTERIOR", "PHARMACY") are good signals. Bank and wallet names after "TO" (OPAY, ZBN, MONIEMFB, PALMPAY, KUDA) are the recipient's bank, not the recipient.
Category meanings: "Own transfer" is money moving between the person's own accounts or wallets (never income or spending). "Transfers" is money sent to other people when nothing more specific fits. "Income" is money received (subcategory: Salary, Consulting, Business income, Refund, Gifts received, Transfer, Interest, Other income).
Confidence is your probability (0 to 1) that a careful human who knows this person would pick the same category. Use below 0.6 when you are guessing. Keep subcategory short (1 to 3 words) or null. Keep reason under 12 words.`;

export const defaultCategorizeLLM: CategorizeLLM = async (rows, ctx) => {
  const res = await anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: "low", format: betaZodOutputFormat(SuggestionSchema) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          allowed_categories: ALL_CATEGORIES,
          profile: ctx.profile,
          users_own_labels: ctx.examples,
          transactions: rows,
        }),
      },
    ],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) return [];
  return res.parsed_output.suggestions;
};

const MIN_CONFIDENCE = 0.6;
const MAX_STORED_CONFIDENCE = 0.85; // AI suggestions never outrank a user answer or a specific rule
const BATCH = 40;

/** Rows worth asking the AI about: generic or low-confidence, never user-set or paired. */
async function candidates(userId: string, limit: number) {
  return db.transaction.findMany({
    where: {
      userId,
      classificationSource: { notIn: ["user", "pair", "ai"] },
      OR: [{ category: { in: ["Transfers", "Other"] } }, { classificationConfidence: { lt: 0.6 } }],
    },
    orderBy: { amountMinor: "desc" },
    take: limit,
  });
}

async function contextFor(userId: string, excludeName?: string): Promise<AiContext> {
  const [profile, aliases] = await Promise.all([
    buildProfile(userId),
    db.merchantAlias.findMany({ where: { userId, category: { not: null } }, take: 80, orderBy: { createdAt: "desc" } }),
  ]);
  return {
    profile: profileText(profile),
    examples: aliases
      .filter((a) => a.subcategory !== SKIPPED && !(excludeName && sameName(a.pattern, excludeName)))
      .map((a) => ({ name: a.canonicalName, category: a.category!, subcategory: a.subcategory })),
  };
}

export function toAiRow(t: { id: string; type: string; description: string; counterparty: string | null }): AiRow {
  return {
    id: t.id,
    type: t.type as TransactionType,
    narration: redactNarration(t.description),
    payee: t.counterparty ?? undefined,
    memo: memoOf(t.description),
  };
}

export function validSuggestion(s: AiSuggestion): boolean {
  return ALL_CATEGORIES.includes(s.category) && Number.isFinite(s.confidence) && s.confidence >= MIN_CONFIDENCE;
}

/**
 * Categorizes up to `limit` uncertain transactions with AI. Returns how many were updated.
 * Requires a server key AND the user's consent unless an llm is injected (tests).
 */
export async function aiCategorize(userId: string, opts: { llm?: CategorizeLLM; limit?: number } = {}): Promise<{ asked: number; updated: number }> {
  if (!opts.llm && !(await aiAllowed(userId))) return { asked: 0, updated: 0 };
  const llm = opts.llm ?? defaultCategorizeLLM;
  const rows = await candidates(userId, opts.limit ?? 200);
  if (!rows.length) return { asked: 0, updated: 0 };
  const ctx = await contextFor(userId);
  let updated = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    let suggestions: AiSuggestion[] = [];
    try {
      suggestions = await llm(batch.map(toAiRow), ctx);
    } catch (e) {
      if (e instanceof Anthropic.APIError) log.warn("ai.categorize_error", { status: e.status });
      else log.warn("ai.categorize_error", { error: e instanceof Error ? e.message : "unknown" });
      continue;
    }
    const byId = new Map(batch.map((r) => [r.id, r]));
    for (const s of suggestions) {
      const row = byId.get(s.id);
      if (!row || !validSuggestion(s)) continue;
      // Direction sanity: income only on credits; spending categories only on debits.
      if ((s.category === "Income") !== (row.type === "CREDIT") && s.category !== OWN_TRANSFER) continue;
      await db.transaction.update({
        where: { id: row.id },
        data: {
          category: s.category,
          subcategory: s.subcategory?.slice(0, 40) || null,
          classificationSource: "ai",
          classificationConfidence: Math.min(s.confidence, MAX_STORED_CONFIDENCE),
        },
      });
      updated++;
    }
  }
  log.info("ai.categorized", { userId, asked: rows.length, updated });
  return { asked: rows.length, updated };
}

/**
 * Classifier for the scorecard: rules first, AI for whatever the rules leave generic.
 * Leave-one-name-out: when scoring a row, the user's label for that same name is withheld from the
 * examples, so the AI is graded on generalising, not on repeating the answer it was given.
 */
export function aiClassifier(userId: string, rules: Classifier, llm: CategorizeLLM = defaultCategorizeLLM): Classifier {
  return async (rows, owners) => {
    const base = await rules(rows, owners);
    const generic = rows.filter((r) => {
      const c = base.get(r.id);
      return !c || c.category === "Transfers" || c.category === "Other" || c.confidence < 0.6;
    });
    const full = await db.transaction.findMany({ where: { id: { in: generic.map((g) => g.id) } }, select: { id: true, type: true, description: true, counterparty: true } });
    const out = new Map(base);
    for (const t of full) {
      const ctx = await contextFor(userId, t.counterparty ?? memoOf(t.description) ?? undefined);
      const [s] = await llm([toAiRow(t)], ctx);
      if (s && validSuggestion(s)) {
        out.set(t.id, { category: s.category, subcategory: s.subcategory ?? undefined, source: "ai", confidence: s.confidence } as Classification);
      }
    }
    return out;
  };
}
