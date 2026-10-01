import Anthropic from "@anthropic-ai/sdk";
import { log } from "@/lib/log";
import type { Facts } from "./answer";

// Optional phrasing layer. Receives only pre-computed facts, never raw transactions,
// and its output is rejected if it contains any number that is not in the facts.

const MODEL = "claude-opus-5-5";

const SYSTEM = `You explain a user's personal finances in plain, warm, concise English (2 to 4 sentences).
You are given FACTS computed exactly from the user's ledger. Rules:
- Use only numbers that appear verbatim in FACTS. Never calculate, round, estimate or invent any figure, date or name.
- If FACTS do not answer the question, say what is missing.
- Do not give investment advice. Do not use dashes as punctuation.`;

function numbersIn(s: string): string[] {
  return (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
}

/** True when every number in `text` appears somewhere in the facts payload. */
export function onlyUsesFactNumbers(text: string, facts: Facts): boolean {
  const allowed = new Set(numbersIn(JSON.stringify(facts)));
  return numbersIn(text).every((n) => allowed.has(n));
}

export function llmEnabled() {
  return !!process.env.ANTHROPIC_API_KEY;
}

export async function phraseAnswer(question: string, facts: Facts): Promise<{ text: string; source: "llm" | "template" }> {
  if (!llmEnabled() || facts.intent === "unknown") return { text: facts.headline, source: "template" };
  try {
    const client = new Anthropic();
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [{ role: "user", content: `QUESTION: ${question}\n\nFACTS:\n${JSON.stringify(facts, null, 2)}` }],
    });
    if (res.stop_reason === "refusal") return { text: facts.headline, source: "template" };
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    if (!text || !onlyUsesFactNumbers(text, facts)) {
      log.warn("ask.llm_rejected", { intent: facts.intent });
      return { text: facts.headline, source: "template" };
    }
    return { text, source: "llm" };
  } catch (e) {
    if (e instanceof Anthropic.APIError) log.warn("ask.llm_error", { status: e.status });
    else log.warn("ask.llm_error", { error: e instanceof Error ? e.message : "unknown" });
    return { text: facts.headline, source: "template" };
  }
}
