import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { formatMoney } from "@/lib/money";
import { INCOME_CATEGORY, OWN_TRANSFER } from "../categorize";
import { loadKnownPeople } from "../ledger";
import { matchPeople, relationshipInfo, type KnownPerson } from "../people-match";
import type { Classifier } from "../eval";
import { AI_CATEGORIES, canonicalLabel, ruleOnly, taxonomyText } from "../taxonomy";
import type { Classification, TransactionType } from "../types";
import {
  FALLBACK, MODEL, aiAllowed, aiConfig, configFor, localEscalationConfig, logServed, redactNarration, routingFor,
  type AiConfig, type AiRouting,
} from "./client";
import { cloudCreate, type CreateMessage } from "./cloud";
import { AiUnavailableError, ollamaChat, type Fetch } from "./ollama";
import { Redactor, bucketMoneyInText, redactorFor } from "./redact";

// AI suggestions for transactions the rules could not place confidently.
//
// Rules and the user's own answers (MerchantAlias) always win: rows they labelled are never sent.
// The model sees ONLY the fields in AiRow. It never sees account numbers (long digit runs are
// redacted), balances, account names, the user's profile or other labels. The cloud model sees even
// less: names become placeholders, amounts become ranges and dates become months (toCloudRow).
// Hybrid: the local model goes first; rows it is unsure about, answers badly or cannot answer
// (Ollama down) get a second opinion from the escalation model (the cloud by default).
// Answers are stored as CategorySuggestion rows; the transaction keeps its rule label until the
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

/** Someone the owner identified, as context for the model. Every spelling, and who they are. */
export interface KnownPersonContext {
  names: string[];
  /** Short relationship label: "spouse", "sibling", "extended family"… */
  relationship: string;
}

export interface CategorizeContext {
  /** Known people named in this batch. Locally sent by name; to the cloud as "PERSON_1 (spouse)". */
  people?: KnownPersonContext[];
}

/** The model call, injectable so tests and evals run without a network. Returns raw, unvalidated items. */
export type CategorizeLLM = (rows: AiRow[], ctx?: CategorizeContext) => Promise<unknown[]>;

export const MIN_CONFIDENCE = 0.6;
/** Rows below this rule confidence are worth a second opinion. */
const LOW_CONFIDENCE = 0.6;
const LOCAL_BATCH = 8; // small local models stay accurate on short lists
const CLOUD_BATCH = 40;

const SYSTEM = `You label Nigerian bank transactions for one person's budgeting app.
For each transaction choose ONE category and ONE subcategory from the allowed list. Use the list exactly as written. Use an empty subcategory only when none fits.
Signals: memo words typed before "TO" ("MONTHLY", "BAL", "LUNCH", "DADDYS AC"), and trade words in payee names ("COUTURE", "PHARMACY", "INTERIOR"). Bank or wallet names after "TO" (OPAY, ZBN, MONIEMFB, PALMPAY, KUDA) are the recipient's bank, not the recipient.
Known people are people the owner identified; their relationship is certain. Payments to a spouse are "Family / Spouse", to siblings "Family / Siblings", to parents "Family / Parents", to children "Family / Children", to extended family "Family / Black tax". Someone not listed may still be family: say so in the reason.
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

/** "- Gift Adebayo Ojo (also OJO GIFT A): spouse", or "- PERSON_1 (spouse)" once redacted. */
export function knownPeopleText(people: { names: string[]; relationship: string }[]): string {
  return people
    .map((p) => {
      const [first, ...rest] = [...new Set(p.names)];
      return first.endsWith(`(${p.relationship})`) ? `- ${first}` : `- ${first}${rest.length ? ` (also ${rest.join(", ")})` : ""}: ${p.relationship}`;
    })
    .join("\n");
}

/** The full user message: the taxonomy, the known people in these rows, and the rows; nothing else. */
export function promptFor(rows: AiRow[], ctx: CategorizeContext = {}): string {
  const people = ctx.people?.length ? `\n\nKnown people:\n${knownPeopleText(ctx.people)}` : "";
  return `Allowed categories and subcategories:\n${taxonomyText()}${people}\n\nTransactions:\n${JSON.stringify(rows)}`;
}

export function ollamaCategorizeLLM(opts: { config?: AiConfig; fetch?: Fetch } = {}): CategorizeLLM {
  return async (rows, ctx) => {
    const out = await ollamaChat({ system: SYSTEM, user: promptFor(rows, ctx), schema: RESPONSE_SCHEMA }, opts);
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

const CLOUD_NOTE = `
Privacy: people's names are replaced by placeholders (PERSON_1, PERSON_2…), with the relationship when the owner gave one ("PERSON_1 (spouse)"), and the account holder by OWNER; [ACCOUNT], [PHONE], [CARD], [EMAIL], [ID] and [NUMBER] mark removed identifiers. Money to or from OWNER is usually "Own transfer". Amounts are ranges and dates are months.`;

/** What the cloud model sees for one row: the local AiRow with names, amount and day redacted. */
export function toCloudRow(row: AiRow, r: Redactor): AiRow {
  r.add(row.counterparty);
  r.add(row.merchantName);
  const out: AiRow = { id: row.id, date: row.date.slice(0, 7), direction: row.direction, amount: bucketMoneyInText(row.amount), narration: r.text(row.narration) };
  if (row.counterparty) out.counterparty = r.text(row.counterparty);
  if (row.merchantName) out.merchantName = r.text(row.merchantName);
  return out;
}

/** Cloud categorizer. Every row goes through toCloudRow; the reasons that come back are restored locally. */
export function cloudCategorizeLLM(opts: { redactor?: Redactor; create?: CreateMessage } = {}): CategorizeLLM {
  return async (rows, ctx) => {
    const r = opts.redactor ?? new Redactor();
    for (const p of ctx?.people ?? []) r.addKnown(p);
    // Names only through the redactor: each known person becomes one labelled placeholder.
    const people = (ctx?.people ?? []).flatMap((p) => {
      const ph = r.placeholderOfName(p.names[0]);
      return ph ? [{ names: [ph], relationship: p.relationship }] : [];
    });
    const res = await (opts.create ?? cloudCreate)({
      model: MODEL,
      max_tokens: 16000,
      ...FALLBACK,
      output_config: { effort: "low", format: betaZodOutputFormat(AnthropicSchema) },
      system: SYSTEM + CLOUD_NOTE,
      messages: [{ role: "user", content: promptFor(rows.map((row) => toCloudRow(row, r)), { people }) }],
    });
    if (res.stop_reason === "refusal") return [];
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let parsed: z.infer<typeof AnthropicSchema> | undefined;
    try {
      const v = AnthropicSchema.safeParse(JSON.parse(text));
      parsed = v.success ? v.data : undefined;
    } catch {
      parsed = undefined;
    }
    return (parsed?.suggestions ?? []).map((s) => ({ ...s, reason: r.restore(s.reason) }));
  };
}

export function llmFor(config: AiConfig = aiConfig(), opts: { redactor?: Redactor } = {}): CategorizeLLM {
  if (config.problem || config.provider === "off") throw new AiUnavailableError(config.problem ?? "AI is off.");
  return config.provider === "anthropic" ? cloudCategorizeLLM(opts) : ollamaCategorizeLLM({ config });
}

/** A model that categorizes, and who it is, for the record on each suggestion. */
export interface Categorizer {
  llm: CategorizeLLM;
  provider: "ollama" | "anthropic";
  model: string;
  batchSize?: number;
}

/**
 * The first-pass categorizer and the second-opinion one for this routing. Undefined when that
 * feature is off. The redactor is created only when something goes to the cloud.
 */
export async function categorizersFor(
  userId: string,
  routing: AiRouting,
  opts: { fetch?: Fetch; escalate?: boolean } = {},
): Promise<{ first?: Categorizer; second?: Categorizer }> {
  const cat = routing.features.categorize.route;
  const esc = opts.escalate === false ? "off" : routing.features.escalation.route;
  let redactor: Redactor | undefined;
  const cloud = async (): Promise<Categorizer> => ({ llm: cloudCategorizeLLM({ redactor: (redactor ??= await redactorFor(userId)) }), provider: "anthropic", model: MODEL, batchSize: CLOUD_BATCH });
  const first: Categorizer | undefined =
    cat === "local" ? { llm: ollamaCategorizeLLM({ config: routing.local, fetch: opts.fetch }), provider: "ollama", model: routing.local.model }
    : cat === "cloud" ? await cloud()
    : undefined;
  let second: Categorizer | undefined;
  if (first && esc === "cloud") second = await cloud();
  if (first && esc === "local") {
    const config = { ...routing.local, model: localEscalationConfig().model };
    second = { llm: ollamaCategorizeLLM({ config, fetch: opts.fetch }), provider: "ollama", model: config.model, batchSize: 1 };
  }
  return { first, second };
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
  /** Who gave the answer shown. */
  provider?: "ollama" | "anthropic";
  escalated?: boolean;
  suggestion?: AiSuggestion;
  rejected?: string;
}

export interface ProviderCount {
  /** Rows sent to this provider. */
  rows: number;
  /** Suggestions kept from this provider. */
  suggested: number;
}

export interface SuggestResult {
  backlog: number;
  asked: number;
  suggested: number;
  rejected: number;
  remaining: number;
  /** Rows sent to each side. An escalated row counts for both. */
  local: ProviderCount;
  cloud: ProviderCount;
  /** Rows that got a second opinion. */
  escalated: number;
  /** Set when the run stopped early because no model could be reached. */
  stopped?: string;
  /** Set when second opinions stopped (e.g. the cloud was unreachable); the run went on with local answers. */
  escalationStopped?: string;
  preview: PreviewRow[];
}

export interface SuggestOptions {
  llm?: CategorizeLLM;
  config?: AiConfig;
  /** First-pass model with its provider and model name (the CLI). Like llm, skips the consent check. */
  categorizer?: Categorizer;
  /** The second-opinion model. Resolved from routing when no llm is injected; false turns it off. */
  escalate?: Categorizer | false;
  /** Routing to use instead of this user's (the CLI passes the server's). */
  routing?: AiRouting;
  fetch?: Fetch;
  limit?: number;
  batchSize?: number;
  /** Ask the model and report, but store nothing. */
  dryRun?: boolean;
  /** Ask again about rows the model could not answer before. */
  retryFailed?: boolean;
  onBatch?: (p: BatchProgress) => void;
}

/** A local answer below this confidence (though above MIN_CONFIDENCE) still gets a second opinion. */
export const ESCALATE_BELOW = 0.75;

/** Unsure, unusable or missing answers get a second opinion. Agreeing with the rules does not. */
export function needsSecondOpinion(v: Verdict): boolean {
  return v.ok ? v.suggestion.confidence < ESCALATE_BELOW : v.reason !== "same as the rules";
}

function verdictsFor(answers: unknown[], rows: { type: string; category: string; subcategory: string | null }[]): Verdict[] {
  const byPosition = new Map<string, unknown>();
  for (const a of answers) {
    const id = a && typeof a === "object" ? String((a as { id?: unknown }).id ?? "") : "";
    if (id && !byPosition.has(id)) byPosition.set(id, a);
  }
  return rows.map((t, k) => {
    const raw = byPosition.get(String(k + 1));
    return raw === undefined ? { ok: false, reason: "no answer" } : validateSuggestion(raw, t);
  });
}

/** The known people these rows may name (matched or close), for the prompt. Nobody else is listed. */
export function peopleContext(people: KnownPerson[], rows: { counterparty: string | null; merchantName: string | null }[]): CategorizeContext {
  const ids = new Set<string>();
  for (const r of rows) {
    for (const name of [r.counterparty, r.merchantName]) {
      const m = matchPeople(name, people);
      if (m.personId) ids.add(m.personId);
      else m.candidates.forEach((c) => ids.add(c.personId));
    }
  }
  const list = people
    .filter((p) => ids.has(p.id) && p.relationship !== "me")
    .map((p) => ({ names: [p.displayName, ...p.aliases.filter((a) => !a.rejected).map((a) => a.name)], relationship: relationshipInfo(p.relationship).short }));
  return list.length ? { people: list } : {};
}

/** One model request, logged by provider (never content). Unreachable models throw; other errors are no answer. */
async function ask(c: Categorizer, feature: "categorize" | "escalation", rows: AiRow[], ctx?: CategorizeContext): Promise<unknown[]> {
  const started = Date.now();
  try {
    const out = await c.llm(rows, ctx);
    logServed(feature, c.provider, c.model, "ok", { ms: Date.now() - started, rows: rows.length });
    return out;
  } catch (e) {
    logServed(feature, c.provider, c.model, "failed", { ms: Date.now() - started, rows: rows.length });
    if (e instanceof AiUnavailableError) throw e;
    log.warn("ai.suggest_error", { feature, provider: c.provider, error: e instanceof Error ? e.name : "unknown" });
    return [];
  }
}

/**
 * Asks the model about up to `limit` backlog rows, in small batches, and stores each answer as a
 * suggestion. With a second-opinion model (hybrid), rows the first model was unsure about, answered
 * badly, or could not answer at all (Ollama down) are asked again there; the better valid answer is
 * kept. Safe to stop and re-run: answered rows leave the backlog. Never throws for an unreachable
 * model; it stops and says why. Requires the user's AI toggle unless an llm is injected.
 */
export async function suggestCategories(userId: string, opts: SuggestOptions = {}): Promise<SuggestResult> {
  const empty = (stopped?: string, backlog = 0): SuggestResult => ({
    backlog, asked: 0, suggested: 0, rejected: 0, remaining: backlog, local: { rows: 0, suggested: 0 }, cloud: { rows: 0, suggested: 0 }, escalated: 0, stopped, preview: [],
  });
  let first: Categorizer | undefined;
  let second: Categorizer | undefined = opts.escalate || undefined;
  if (opts.categorizer) {
    first = opts.categorizer;
  } else if (opts.llm) {
    const config = opts.config ?? aiConfig();
    first = { llm: opts.llm, provider: config.provider === "anthropic" ? "anthropic" : "ollama", model: config.model };
  } else {
    const routing = opts.routing ?? (await routingFor(userId));
    const cat = routing.features.categorize;
    if (routing.problem || cat.route === "off") return empty(routing.problem ?? cat.note ?? "AI categorization is off.");
    if (!(await aiAllowed(userId))) return empty("AI is switched off for this account. Turn it on in Settings.");
    const resolved = await categorizersFor(userId, routing, { fetch: opts.fetch, escalate: opts.escalate !== false });
    first = resolved.first;
    second = opts.escalate === false ? undefined : (opts.escalate || resolved.second);
    if (!first) return empty(configFor(routing, cat.route).problem ?? "AI categorization is off.");
  }
  const primary: Categorizer = first;
  const retryFailed = !!opts.retryFailed;
  const backlog = await backlogCount(userId, retryFailed);
  const rows = await db.transaction.findMany({
    where: backlogWhere(userId, retryFailed),
    orderBy: [{ amountMinor: "desc" }, { id: "asc" }],
    take: Math.max(0, opts.limit ?? 200),
    select: { id: true, type: true, amountMinor: true, currency: true, transactionDate: true, description: true, counterparty: true, merchantName: true, category: true, subcategory: true },
  });
  if (!rows.length) return empty(undefined, backlog);

  const size = Math.max(1, opts.batchSize ?? primary.batchSize ?? LOCAL_BATCH);
  const known = await loadKnownPeople(userId);
  const result = empty(undefined, backlog);
  const tally = (c: Categorizer) => (c.provider === "anthropic" ? result.cloud : result.local);
  let firstDown: string | undefined;

  for (let i = 0; i < rows.length; i += size) {
    const batch = rows.slice(i, i + size);
    const aiRows = batch.map((t, k) => toAiRow(String(k + 1), t));
    const ctx = peopleContext(known, batch);
    let answers: unknown[] | undefined;
    if (!firstDown) {
      try {
        answers = await ask(primary, "categorize", aiRows, ctx);
        tally(primary).rows += batch.length;
      } catch (e) {
        firstDown = e instanceof Error ? e.message : "AI unavailable";
      }
    }
    if (firstDown && (!second || result.escalationStopped)) {
      result.stopped = [firstDown, result.escalationStopped].filter(Boolean).join(" ");
      break;
    }

    const verdicts = answers ? verdictsFor(answers, batch) : batch.map((): Verdict => ({ ok: false, reason: "no answer" }));
    const decided = verdicts.map((verdict) => ({ verdict, by: primary, escalated: false }));
    const answered = batch.map(() => !!answers);
    const pick = second && !result.escalationStopped ? batch.map((_, k) => k).filter((k) => !answers || needsSecondOpinion(verdicts[k])) : [];
    const step = Math.max(1, second?.batchSize ?? CLOUD_BATCH);
    for (let j = 0; second && j < pick.length; j += step) {
      const ks = pick.slice(j, j + step);
      let again: unknown[];
      try {
        again = await ask(second, "escalation", ks.map((k, n) => toAiRow(String(n + 1), batch[k])), peopleContext(known, ks.map((k) => batch[k])));
      } catch (e) {
        result.escalationStopped = e instanceof Error ? e.message : "Second opinion unavailable.";
        break;
      }
      tally(second).rows += ks.length;
      result.escalated += ks.length;
      const v2 = verdictsFor(again, ks.map((k) => batch[k]));
      ks.forEach((k, n) => {
        answered[k] = true;
        if (v2[n].ok || !decided[k].verdict.ok) decided[k] = { verdict: v2[n], by: second!, escalated: true };
      });
    }
    if (!answered.some(Boolean)) {
      result.stopped = [firstDown, result.escalationStopped].filter(Boolean).join(" ") || "AI unavailable.";
      break;
    }

    for (const [k, t] of batch.entries()) {
      if (!answered[k]) continue;
      const { verdict, by, escalated } = decided[k];
      result.asked++;
      if (verdict.ok) {
        result.suggested++;
        tally(by).suggested++;
      } else result.rejected++;
      if (opts.dryRun) {
        result.preview.push({
          transactionId: t.id,
          narration: aiRows[k].narration,
          amount: aiRows[k].amount,
          current: [t.category, t.subcategory].filter(Boolean).join(" / "),
          provider: by.provider,
          escalated,
          ...(verdict.ok ? { suggestion: verdict.suggestion } : { rejected: verdict.reason }),
        });
        continue;
      }
      const data = verdict.ok
        ? { category: verdict.suggestion.category, subcategory: verdict.suggestion.subcategory, reason: verdict.suggestion.reason, confidence: verdict.suggestion.confidence, status: "pending" }
        : { category: null, subcategory: null, reason: verdict.reason, confidence: null, status: "failed" };
      await db.categorySuggestion.upsert({
        where: { transactionId: t.id },
        create: { userId, transactionId: t.id, classificationSource: "ai", provider: by.provider, model: by.model, ...data },
        update: { provider: by.provider, model: by.model, decidedAt: null, ...data },
      });
    }
    if (!opts.dryRun) result.remaining = Math.max(0, backlog - result.asked);
    opts.onBatch?.({ done: result.asked, total: rows.length, suggested: result.suggested, rejected: result.rejected });
  }
  log.info("ai.suggested", { userId, asked: result.asked, suggested: result.suggested, local: result.local.rows, cloud: result.cloud.rows, escalated: result.escalated, stopped: !!result.stopped });
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
