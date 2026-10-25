import { log } from "@/lib/log";
import { FALLBACK, MODEL, localConfig, logServed, type AiConfig, type AiRoute } from "../ai/client";
import { cloudCreate, type CreateMessage } from "../ai/cloud";
import { ollamaChat, type Fetch } from "../ai/ollama";
import { Redactor, roundedMoney } from "../ai/redact";
import type { Facts } from "./answer";

// Optional phrasing layer ("Insights phrasing"). Receives only pre-computed facts, never raw
// transactions, and its output is rejected if it contains any number that is not in what it was sent.
// Cloud: a redacted copy of the facts (names as placeholders, amounts rounded, no raw kobo).
// Local: the facts as they are, on Ollama.

const SYSTEM = `You explain a user's personal finances in plain, warm, concise English (2 to 4 sentences).
You are given FACTS computed exactly from the user's ledger. Rules:
- Use only numbers that appear verbatim in FACTS. Never calculate, round, estimate or invent any figure, date or name.
- If FACTS do not answer the question, say what is missing.
- Do not give investment advice. Do not use dashes as punctuation.`;

const CLOUD_NOTE = `
- Names of people are placeholders (PERSON_1…) and the user is OWNER; keep them exactly as written. Amounts are rounded: you may say "about".`;

function numbersIn(s: string): string[] {
  return (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
}

/** True when every number in `text` appears somewhere in the facts payload. */
export function onlyUsesFactNumbers(text: string, facts: unknown): boolean {
  const allowed = new Set(numbersIn(JSON.stringify(facts)));
  return numbersIn(text).every((n) => allowed.has(n));
}

/** What the cloud sees: labels and rows redacted, values rounded, no headline and no raw minor units. */
export function cloudFacts(facts: Facts, r: Redactor) {
  return {
    intent: facts.intent,
    period: facts.period,
    facts: facts.facts.map((f) => ({ label: r.textRounded(f.label), value: f.minor !== undefined ? roundedMoney(BigInt(f.minor)) : r.textRounded(f.value) })),
    ...(facts.rows ? { rows: facts.rows.map((x) => ({ date: x.date, description: r.text(x.description), category: x.category, amount: r.textRounded(x.amount), type: x.type })) } : {}),
  };
}

export interface PhraseOptions {
  /** Cloud model call, injectable for tests. */
  create?: CreateMessage;
  redactor?: Redactor;
  /** Local model. */
  config?: AiConfig;
  fetch?: Fetch;
}

export type Phrased = { text: string; source: "llm" | "template"; provider?: "ollama" | "anthropic" };

export async function phraseAnswer(question: string, facts: Facts, route: AiRoute = "off", opts: PhraseOptions = {}): Promise<Phrased> {
  const template: Phrased = { text: facts.headline, source: "template" };
  if (route === "off" || facts.intent === "unknown") return template;
  const started = Date.now();
  if (route === "local") {
    const config = opts.config ?? localConfig();
    try {
      const out = (await ollamaChat(
        {
          system: SYSTEM,
          user: `QUESTION: ${question}\n\nFACTS:\n${JSON.stringify(facts, null, 2)}`,
          schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
        },
        { config, fetch: opts.fetch, timeoutMs: 60_000 },
      )) as { answer?: unknown } | undefined;
      const text = typeof out?.answer === "string" ? out.answer.trim() : "";
      if (!text || !onlyUsesFactNumbers(text, facts)) {
        logServed("insights", "ollama", config.model, "rejected", { ms: Date.now() - started });
        return template;
      }
      logServed("insights", "ollama", config.model, "ok", { ms: Date.now() - started });
      return { text, source: "llm", provider: "ollama" };
    } catch (e) {
      logServed("insights", "ollama", config.model, "failed", { ms: Date.now() - started });
      log.warn("ask.llm_error", { provider: "ollama", error: e instanceof Error ? e.name : "unknown" });
      return template;
    }
  }
  const r = opts.redactor ?? new Redactor();
  const payload = cloudFacts(facts, r);
  const q = r.text(question);
  try {
    const res = await (opts.create ?? cloudCreate)({
      model: MODEL,
      max_tokens: 2000,
      ...FALLBACK,
      output_config: { effort: "low" },
      system: SYSTEM + CLOUD_NOTE,
      messages: [{ role: "user", content: `QUESTION: ${q}\n\nFACTS:\n${JSON.stringify(payload, null, 2)}` }],
    });
    if (res.stop_reason === "refusal") return template;
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    if (!text || !onlyUsesFactNumbers(text, { payload, q })) {
      logServed("insights", "anthropic", MODEL, "rejected", { ms: Date.now() - started });
      log.warn("ask.llm_rejected", { intent: facts.intent });
      return template;
    }
    logServed("insights", "anthropic", MODEL, "ok", { ms: Date.now() - started });
    return { text: r.restore(text), source: "llm", provider: "anthropic" };
  } catch (e) {
    logServed("insights", "anthropic", MODEL, "failed", { ms: Date.now() - started });
    log.warn("ask.llm_error", { provider: "anthropic", error: e instanceof Error ? e.name : "unknown" });
    return template;
  }
}
