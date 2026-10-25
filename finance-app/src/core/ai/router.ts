import { log } from "@/lib/log";
import type { Facts } from "../ask/answer";
import { phraseAnswer, type Phrased, type PhraseOptions } from "../ask/llm";
import { askAssistant, askAssistantLocal, type AssistantReply, type AssistantTurn, type CreateMessage } from "./assistant";
import { aiAllowed, routingFor } from "./client";
import type { Fetch } from "./ollama";
import { redactorFor } from "./redact";

// Per-user dispatch for Insights phrasing and chat: picks local or cloud from the user's routing,
// builds the Redactor for cloud calls, and falls back (cloud -> local -> rules) when a model fails.

export interface RouteDeps {
  create?: CreateMessage;
  fetch?: Fetch;
  now?: Date;
}

export async function phraseForUser(userId: string, question: string, facts: Facts, deps: RouteDeps = {}): Promise<Phrased> {
  if (!(await aiAllowed(userId))) return { text: facts.headline, source: "template" };
  const routing = await routingFor(userId);
  const route = routing.features.insights.route;
  const opts: PhraseOptions = { create: deps.create, fetch: deps.fetch, config: routing.local };
  if (route === "cloud") opts.redactor = await redactorFor(userId);
  return phraseAnswer(question, facts, route, opts);
}

/** The AI assistant's answer, or undefined when chat is off or no model could answer (the caller uses rules). */
export async function chatForUser(userId: string, question: string, history: AssistantTurn[], deps: RouteDeps = {}): Promise<AssistantReply | undefined> {
  if (!(await aiAllowed(userId))) return undefined;
  const routing = await routingFor(userId);
  const route = routing.features.chat.route;
  if (route === "off") return undefined;
  if (route === "cloud") {
    try {
      return await askAssistant(userId, question, history, { create: deps.create, now: deps.now });
    } catch (e) {
      log.warn("chat.cloud_failed", { error: e instanceof Error ? e.name : "unknown" });
      if (routing.local.problem) return undefined;
    }
  }
  try {
    return await askAssistantLocal(userId, question, history, { config: routing.local, fetch: deps.fetch, now: deps.now });
  } catch (e) {
    log.warn("chat.local_failed", { error: e instanceof Error ? e.name : "unknown" });
    return undefined;
  }
}
