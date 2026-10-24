import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { formatMoney } from "@/lib/money";
import { INCOME_CATEGORY, OWN_TRANSFER } from "../categorize";
import type { Classifier } from "../eval";
import { AI_CATEGORIES, canonicalLabel, ruleOnly, taxonomyText } from "../taxonomy";
import type { Classification, TransactionType } from "../types";
import { FALLBACK, MODEL, aiAllowed, aiConfig, anthropic, redactNarration, type AiConfig } from "./client";
import { AiUnavailableError, ollamaChat, type Fetch } from "./ollama";

// AI suggestions for transactions the rules could not place confidently.
//
// Rules and the user's own answers (MerchantAlias) always win: rows they labelled are never sent.
// The model sees ONLY the fields in AiRow. It never sees account numbers (long digit runs are
// redacted), balances, account names, the user's profile or other labels.
// Its answers are stored as CategorySuggestion rows; the transaction keeps its rule label until the
// owner confirms in Review, so nothing the model says changes totals or affordability on its own.

/** Exactly what a model may see about one transaction. */
export interface AiRow {
  /** Position in this request ("1", "2", …), not a database id. */
  id: string;
  /** Lagos calendar day, YYYY-MM-DD. */
  date: string;
  direction: "in" | "out";
  /** "₦250,000.00" */
  amount: string;
  /** The bank narration with long digit runs removed. */
  narration: string;
  counterparty?: string;
  merchantName?: string;
}

export const AI_ROW_FIELDS = ["id", "date", "direction", "amount", "narration", "counterparty", "merchantName"] as const;

export interface AiSuggestion {
  id: string;
  category: string;
  subcategory: string | null;
  confidence: number;
  reason: string;
}

/** The model call, injectable so tests and evals run without a network. Returns raw, unvalidated items. */
export type CategorizeLLM = (rows: AiRow[]) => Promise<unknown[]>;

export const MIN_CONFIDENCE = 0.6;
/** Rows below this rule confidence are worth a second opinion. */
const LOW_CONFIDENCE = 0.6;
const LOCAL_BATCH = 8; // small local models stay accurate on short lists
const CLOUD_BATCH = 40;

const SYSTEM = `You label Nigerian bank transactions for one person's budgeting app.
For each transaction choose ONE category and ONE subcategory from the allowed list. Use the list exactly as written. Use an empty subcategory only when none fits.
Signals: memo words typed before "TO" ("MONTHLY", "BAL", "LUNCH", "DADDYS AC"), and trade words in payee names ("COUTURE", "PHARMACY", "INTERIOR"). Bank or wallet names after "TO" (OPAY, ZBN, MONIEMFB, PALMPAY, KUDA) are the recipient's bank, not the recipient.
Meanings: "Own transfer" is money between the person's own accounts, wallets or savings. "Transfers" is money sent to other people when nothing more specific fits. "Family / Black tax" is support for extended family or community. "Debt / Loan repayment" is paying back a lender. "Income" is only for money in; money out is never Income.
confidence is the probability (0 to 1) that a careful person who knows this household would pick the same label; use below 0.6 when guessing. reason is under 12 words.
Answer with JSON only, one item per transaction, using the same id.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          category: { type: "string", enum: AI_CATEGORIES },
          subcategory: { type: "string" },
          confidence: { type: "number" },
          reason: { type: "string" },
        },
        required: ["id", "category", "subcategory", "confidence", "reason"],
      },
    },
  },
  required: ["suggestions"],
} as const;

/** The full user message: the taxonomy and the rows, nothing else. */
export function promptFor(rows: AiRow[]): string {
  return `Allowed categories and subcategories:\n${taxonomyText()}\n\nTransactions:\n${JSON.stringify(rows)}`;
}

export function ollamaCategorizeLLM(opts: { config?: AiConfig; fetch?: Fetch } = {}): CategorizeLLM {
  return async (rows) => {
    const out = await ollamaChat({ system: SYSTEM, user: promptFor(rows), schema: RESPONSE_SCHEMA }, opts);
    const list = (out as { suggestions?: unknown } | undefined)?.suggestions;
    return Array.isArray(list) ? list : [];
  };
}

const AnthropicSchema = z.object({
  suggestions: z.array(
    z.object({
      id: z.string(),
      category: z.enum(AI_CATEGORIES as [string, ...string[]]),
      subcategory: z.string(),
      confidence: z.number(),
      reason: z.string(),
    }),
  ),
});

/** Cloud path. Only reachable when AI_PROVIDER=anthropic is set explicitly. */
export const anthropicCategorizeLLM: CategorizeLLM = async (rows) => {
  try {
    const res = await anthropic().beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      ...FALLBACK,
      output_config: { effort: "low", format: betaZodOutputFormat(AnthropicSchema) },
      system: SYSTEM,
      messages: [{ role: "user", content: promptFor(rows) }],
    });
    if (res.stop_reason === "refusal" || !res.parsed_output) return [];
    return res.parsed_output.suggestions;
  } catch (e) {
    if (e instanceof Anthropic.APIConnectionError) throw new AiUnavailableError("Could not reach Anthropic.");
    if (e instanceof Anthropic.APIError && (e.status === 401 || e.status === 403 || e.status === 429 || (e.status ?? 0) >= 500)) {
      throw new AiUnavailableError(`Anthropic returned ${e.status}.`);
    }
    throw e;
  }
};

export function llmFor(config: AiConfig = aiConfig()): CategorizeLLM {
  if (config.problem || config.provider === "off") throw new AiUnavailableError(config.problem ?? "AI is off.");
  return config.provider === "anthropic" ? anthropicCategorizeLLM : ollamaCategorizeLLM({ config });
}

const lagosDay = (d: Date) => new Date(d.getTime() + 3600_000).toISOString().slice(0, 10);

interface SourceRow {
  type: string;
  amountMinor: bigint;
  currency: string;
  transactionDate: Date;
  description: string;
  counterparty: string | null;
  merchantName: string | null;
}

/** Builds the model's view of a row. Picks fields one by one so nothing else can slip through. */
export function toAiRow(id: string, t: SourceRow): AiRow {
  const row: AiRow = {
    id,
    date: lagosDay(t.transactionDate),
    direction: t.type === "CREDIT" ? "in" : "out",
    amount: formatMoney(t.amountMinor, t.currency),
    narration: redactNarration(t.description),
  };
  if (t.counterparty) row.counterparty = redactNarration(t.counterparty);
  if (t.merchantName && t.merchantName !== t.counterparty) row.merchantName = redactNarration(t.merchantName);
  return row;
}

export type Verdict = { ok: true; suggestion: AiSuggestion } | { ok: false; reason: string };

/**
 * Accepts a model answer only when it is in the taxonomy, fits the money's direction, is confident
 * enough, and says something more specific than the row already has.
 */
export function validateSuggestion(raw: unknown, row: { type: string; category: string; subcategory: string | null }): Verdict {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "not an object" };
  const r = raw as Record<string, unknown>;
  const label = canonicalLabel(r.category, r.subcategory);
  if (!label) return { ok: false, reason: "not in the taxonomy" };
  if (ruleOnly(label.category, label.subcategory)) return { ok: false, reason: "only the rules give this label" };
  const confidence = typeof r.confidence === "number" ? r.confidence : Number.NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { ok: false, reason: "bad confidence" };
  if (confidence < MIN_CONFIDENCE) return { ok: false, reason: "low confidence" };
  const credit = row.type === "CREDIT";
  if (credit && ![INCOME_CATEGORY, OWN_TRANSFER, "Debt"].includes(label.category)) return { ok: false, reason: "spending label on money in" };
  if (!credit && label.category === INCOME_CATEGORY) return { ok: false, reason: "income label on money out" };
  if (!credit && label.category === "Debt" && label.subcategory === "Loan proceeds") return { ok: false, reason: "loan proceeds on money out" };
  if ((label.category === "Transfers" || label.category === "Other") && !label.subcategory) return { ok: false, reason: "too generic" };
  if (label.category === row.category && label.subcategory === (row.subcategory ?? null)) return { ok: false, reason: "same as the rules" };
  const reason = typeof r.reason === "string" ? r.reason.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return { ok: true, suggestion: { id: String(r.id ?? ""), ...label, confidence, reason } };
}

/** Rows the rules could not label confidently, that the owner has not labelled, and that the AI has not seen. */
function backlogWhere(userId: string, retryFailed: boolean) {
  return {
    userId,
    classificationSource: { notIn: ["user", "pair"] },
    transferPairId: null,
    AND: [
      {
        OR: [
          { classificationSource: "default" },
          { category: { in: ["Transfers", "Other"] }, subcategory: null },
          { classificationConfidence: { lt: LOW_CONFIDENCE } },
        ],
      },
      retryFailed ? { OR: [{ suggestion: { is: null } }, { suggestion: { is: { status: "failed" } } }] } : { suggestion: { is: null } },
    ],
  };
}

export async function backlogCount(userId: string, retryFailed = false): Promise<number> {
  return db.transaction.count({ where: backlogWhere(userId, retryFailed) });
}

export interface BatchProgress {
  done: number;
  total: number;
  suggested: number;
  rejected: number;
}

export interface PreviewRow {
  transactionId: string;
  narration: string;
  amount: string;
  current: string;
  suggestion?: AiSuggestion;
  rejected?: string;
}

export interface SuggestResult {
  backlog: number;
  asked: number;
  suggested: number;
  rejected: number;
  remaining: number;
  /** Set when the run stopped early because the model could not be reached. */
  stopped?: string;
  preview: PreviewRow[];
}

export interface SuggestOptions {
  llm?: CategorizeLLM;
  config?: AiConfig;
  limit?: number;
  batchSize?: number;
  /** Ask the model and report, but store nothing. */
  dryRun?: boolean;
  /** Ask again about rows the model could not answer before. */
  retryFailed?: boolean;
  onBatch?: (p: BatchProgress) => void;
}

/**
 * Asks the model about up to `limit` backlog rows, in small batches, and stores each answer as a
 * suggestion. Safe to stop and re-run: answered rows leave the backlog. Never throws for an
 * unreachable model; it stops and says why. Requires the user's AI toggle unless an llm is injected.
 */
export async function suggestCategories(userId: string, opts: SuggestOptions = {}): Promise<SuggestResult> {
  const config = opts.config ?? aiConfig();
  const empty = (stopped?: string, backlog = 0): SuggestResult => ({ backlog, asked: 0, suggested: 0, rejected: 0, remaining: backlog, stopped, preview: [] });
  if (!opts.llm) {
    if (config.provider === "off" || config.problem) return empty(config.problem ?? "AI is off on this server.");
    if (!(await aiAllowed(userId))) return empty("AI is switched off for this account. Turn it on in Settings.");
  }
  const retryFailed = !!opts.retryFailed;
  const backlog = await backlogCount(userId, retryFailed);
  const rows = await db.transaction.findMany({
    where: backlogWhere(userId, retryFailed),
    orderBy: [{ amountMinor: "desc" }, { id: "asc" }],
    take: Math.max(0, opts.limit ?? 200),
    select: { id: true, type: true, amountMinor: true, currency: true, transactionDate: true, description: true, counterparty: true, merchantName: true, category: true, subcategory: true },
  });
  if (!rows.length) return empty(undefined, backlog);

  let llm: CategorizeLLM;
  try {
    llm = opts.llm ?? llmFor(config);
  } catch (e) {
    return empty(e instanceof Error ? e.message : "AI unavailable", backlog);
  }
  const size = Math.max(1, opts.batchSize ?? (config.provider === "anthropic" ? CLOUD_BATCH : LOCAL_BATCH));
  const result: SuggestResult = { backlog, asked: 0, suggested: 0, rejected: 0, remaining: backlog, preview: [] };

  for (let i = 0; i < rows.length; i += size) {
    const batch = rows.slice(i, i + size);
    const aiRows = batch.map((t, k) => toAiRow(String(k + 1), t));
    let answers: unknown[];
    try {
      answers = await llm(aiRows);
    } catch (e) {
      if (e instanceof AiUnavailableError) {
        result.stopped = e.message;
        break;
      }
      log.warn("ai.suggest_error", { error: e instanceof Error ? e.message : "unknown" });
      answers = [];
    }
    const byPosition = new Map<string, unknown>();
    for (const a of answers) {
      const id = a && typeof a === "object" ? String((a as { id?: unknown }).id ?? "") : "";
      if (id && !byPosition.has(id)) byPosition.set(id, a);
    }
    for (const [k, t] of batch.entries()) {
      const raw = byPosition.get(String(k + 1));
      const verdict: Verdict = raw === undefined ? { ok: false, reason: "no answer" } : validateSuggestion(raw, t);
      if (verdict.ok) result.suggested++;
      else result.rejected++;
      if (opts.dryRun) {
        result.preview.push({
          transactionId: t.id,
          narration: aiRows[k].narration,
          amount: aiRows[k].amount,
          current: [t.category, t.subcategory].filter(Boolean).join(" / "),
          ...(verdict.ok ? { suggestion: verdict.suggestion } : { rejected: verdict.reason }),
        });
        continue;
      }
      const data = verdict.ok
        ? { category: verdict.suggestion.category, subcategory: verdict.suggestion.subcategory, reason: verdict.suggestion.reason, confidence: verdict.suggestion.confidence, status: "pending" }
        : { category: null, subcategory: null, reason: verdict.reason, confidence: null, status: "failed" };
      await db.categorySuggestion.upsert({
        where: { transactionId: t.id },
        create: { userId, transactionId: t.id, classificationSource: "ai", provider: config.provider, model: config.model, ...data },
        update: { provider: config.provider, model: config.model, decidedAt: null, ...data },
      });
    }
    result.asked += batch.length;
    if (!opts.dryRun) result.remaining = Math.max(0, backlog - result.asked);
    opts.onBatch?.({ done: result.asked, total: rows.length, suggested: result.suggested, rejected: result.rejected });
  }
  log.info("ai.suggested", { userId, provider: config.provider, asked: result.asked, suggested: result.suggested, stopped: !!result.stopped });
  return result;
}

/** After an import: suggest for a few new rows in the background, so the upload itself stays fast. */
export function suggestInBackground(userId: string): void {
  void aiAllowed(userId)
    .then((ok) => (ok ? suggestCategories(userId, { limit: 40 }) : undefined))
    .catch((e: unknown) => log.warn("ai.background_failed", { error: e instanceof Error ? e.message : "unknown" }));
}

/**
 * Classifier for the scorecard: rules first, AI for whatever the rules leave generic.
 * The model only ever sees AiRow fields, never the user's labels, so it cannot repeat the answer.
 */
export function aiClassifier(userId: string, rules: Classifier, llm: CategorizeLLM = llmFor()): Classifier {
  return async (rows, owners) => {
    const base = await rules(rows, owners);
    const generic = rows.filter((r) => {
      const c = base.get(r.id);
      return !c || c.source === "default" || ((c.category === "Transfers" || c.category === "Other") && !c.subcategory) || c.confidence < LOW_CONFIDENCE;
    });
    const full = await db.transaction.findMany({
      where: { userId, id: { in: generic.map((g) => g.id) } },
      select: { id: true, type: true, amountMinor: true, currency: true, transactionDate: true, description: true, counterparty: true, merchantName: true },
    });
    const out = new Map(base);
    for (let i = 0; i < full.length; i += LOCAL_BATCH) {
      const batch = full.slice(i, i + LOCAL_BATCH);
      let answers: unknown[] = [];
      try {
        answers = await llm(batch.map((t, k) => toAiRow(String(k + 1), t)));
      } catch (e) {
        if (e instanceof AiUnavailableError) break;
        continue;
      }
      for (const [k, t] of batch.entries()) {
        const raw = answers.find((a) => a && typeof a === "object" && String((a as { id?: unknown }).id) === String(k + 1));
        const b = base.get(t.id);
        const v = raw ? validateSuggestion(raw, { type: t.type as TransactionType, category: b?.category ?? "", subcategory: b?.subcategory ?? null }) : undefined;
        if (v?.ok) out.set(t.id, { category: v.suggestion.category, subcategory: v.suggestion.subcategory ?? undefined, source: "ai", confidence: v.suggestion.confidence } as Classification);
      }
    }
    return out;
  };
}
