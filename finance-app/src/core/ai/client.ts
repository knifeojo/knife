import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";

// One place for which model runs and whether it may run.
//
// AI_PROVIDER picks the provider. Unset means "ollama": a model on this machine, so nothing leaves it.
// The Anthropic cloud path runs only when AI_PROVIDER=anthropic is set explicitly AND a key exists.
// AI_PROVIDER=off disables AI for everyone. Every AI feature also needs the user's own toggle (Settings).

export type AiProviderName = "ollama" | "anthropic" | "off";

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
/** Small enough for an 8 GB MacBook Air. Swap with OLLAMA_MODEL (e.g. qwen2.5:7b or llama3.1:8b on 16 GB+). */
export const DEFAULT_OLLAMA_MODEL = "qwen2.5:3b";

export const MODEL = "claude-opus-5-5";
// Server-side refusal fallback: if a request is declined by a safety classifier, the API reruns it
// on a fallback model inside the same call. Default routing, no model list to maintain.
export const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

export interface AiConfig {
  provider: AiProviderName;
  model: string;
  /** Ollama only. */
  baseUrl?: string;
  /** Why the provider cannot run, when it cannot. */
  problem?: string;
  /** True when requests leave this machine. */
  cloud: boolean;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Only loopback addresses count as local. A LAN or Tailscale address is another machine. */
export function isLocalUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return LOCAL_HOSTS.has(u.hostname) || /^127(\.\d{1,3}){3}$/.test(u.hostname);
  } catch {
    return false;
  }
}

export function aiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const raw = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "none" || raw === "disabled") return { provider: "off", model: "", cloud: false, problem: "AI is turned off on this server (AI_PROVIDER=off)." };
  if (raw === "anthropic" || raw === "claude") {
    const hasKey = !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
    return { provider: "anthropic", model: MODEL, cloud: true, problem: hasKey ? undefined : "AI_PROVIDER=anthropic but no ANTHROPIC_API_KEY is set." };
  }
  const baseUrl = (env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  const model = env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
  if (raw && raw !== "ollama" && raw !== "local") {
    return { provider: "off", model: "", cloud: false, problem: `Unknown AI_PROVIDER "${raw}". Use ollama (default), anthropic or off.` };
  }
  if (!isLocalUrl(baseUrl)) {
    return { provider: "ollama", model, baseUrl, cloud: false, problem: "OLLAMA_BASE_URL must be on this machine (localhost or 127.0.0.1). Ledger never sends transactions to another host unless AI_PROVIDER names a cloud provider." };
  }
  return { provider: "ollama", model, baseUrl, cloud: false };
}

/** The server can run AI categorization (the model may still be unreachable right now). */
export function aiConfigured(): boolean {
  const c = aiConfig();
  return c.provider !== "off" && !c.problem;
}

/** AI categorization for this user: configured on the server and switched on by the user. */
export async function aiAllowed(userId: string): Promise<boolean> {
  if (!aiConfigured()) return false;
  const u = await db.user.findUnique({ where: { id: userId }, select: { aiConsent: true } });
  return !!u?.aiConsent;
}

/** The Insights assistant is Claude-only: it runs when the cloud provider is chosen explicitly and the user allows AI. */
export async function cloudAiAllowed(userId: string): Promise<boolean> {
  const c = aiConfig();
  if (c.provider !== "anthropic" || c.problem) return false;
  return aiAllowed(userId);
}

let client: Anthropic | undefined;
export function anthropic(): Anthropic {
  return (client ??= new Anthropic());
}

/** Long digit runs (account numbers, session ids) are removed before anything reaches a model. */
export function redactNarration(s: string): string {
  return s.replace(/\d{6,}/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
}
