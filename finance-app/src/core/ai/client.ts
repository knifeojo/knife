import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { log } from "@/lib/log";

// One place for which model runs each AI feature, and whether it may run.
//
// AI_PROVIDER picks the mode:
//   hybrid (default)  categorization on local Ollama; Insights phrasing, chat and second opinions on
//                     the cloud model (Anthropic), always through the redaction layer (./redact.ts).
//                     Without ANTHROPIC_API_KEY it degrades to local-only and says so.
//   ollama            everything local; nothing leaves this machine, whatever else is set.
//   anthropic         everything cloud (redacted). Without a key the cloud features are off.
//   off               no AI for anyone.
// Each feature (categorize, escalation, insights, chat) can be set to local, cloud or off with
// AI_CATEGORIZE, AI_ESCALATION, AI_INSIGHTS, AI_CHAT, and per user in Settings. Every AI feature also
// needs the user's own toggle (Settings).

export type AiProviderName = "ollama" | "anthropic" | "off";
export type AiMode = "hybrid" | "ollama" | "anthropic" | "off";
export const AI_FEATURES = ["categorize", "escalation", "insights", "chat"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];
export const AI_ROUTES = ["local", "cloud", "off"] as const;
export type AiRoute = (typeof AI_ROUTES)[number];
export type AiPrefs = Partial<Record<AiFeature, AiRoute | null | undefined>>;

export const FEATURE_LABELS: Record<AiFeature, string> = {
  categorize: "Categorize",
  escalation: "Escalation (second opinion)",
  insights: "Insights phrasing",
  chat: "Chat",
};

export const FEATURE_ENV: Record<AiFeature, string> = {
  categorize: "AI_CATEGORIZE",
  escalation: "AI_ESCALATION",
  insights: "AI_INSIGHTS",
  chat: "AI_CHAT",
};

const MODE_DEFAULTS: Record<AiMode, Record<AiFeature, AiRoute>> = {
  hybrid: { categorize: "local", escalation: "cloud", insights: "cloud", chat: "cloud" },
  ollama: { categorize: "local", escalation: "off", insights: "off", chat: "off" },
  anthropic: { categorize: "cloud", escalation: "off", insights: "cloud", chat: "cloud" },
  off: { categorize: "off", escalation: "off", insights: "off", chat: "off" },
};

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

type Env = Record<string, string | undefined>;

export function aiMode(env: Env = process.env): { mode: AiMode; problem?: string } {
  const raw = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (!raw || raw === "hybrid" || raw === "mixed") return { mode: "hybrid" };
  if (raw === "off" || raw === "none" || raw === "disabled") return { mode: "off", problem: "AI is turned off on this server (AI_PROVIDER=off)." };
  if (raw === "anthropic" || raw === "claude" || raw === "cloud") return { mode: "anthropic" };
  if (raw === "ollama" || raw === "local") return { mode: "ollama" };
  return { mode: "off", problem: `Unknown AI_PROVIDER "${raw}". Use hybrid (default), ollama, anthropic or off.` };
}

export const cloudKeySet = (env: Env = process.env) => !!(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());

/** The local provider: Ollama on this machine. */
export function localConfig(env: Env = process.env): AiConfig {
  const baseUrl = (env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  const model = env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
  if (!isLocalUrl(baseUrl)) {
    return { provider: "ollama", model, baseUrl, cloud: false, problem: "OLLAMA_BASE_URL must be on this machine (localhost or 127.0.0.1). Ledger never sends transactions to another host except the cloud provider, and only through redaction." };
  }
  return { provider: "ollama", model, baseUrl, cloud: false };
}

/** The local model for second opinions: OLLAMA_ESCALATION_MODEL (e.g. a bigger one), else the same model. */
export function localEscalationConfig(env: Env = process.env): AiConfig {
  const c = localConfig(env);
  return { ...c, model: env.OLLAMA_ESCALATION_MODEL?.trim() || c.model };
}

/** The cloud provider: Anthropic. */
export function cloudConfig(env: Env = process.env): AiConfig {
  return { provider: "anthropic", model: MODEL, cloud: true, problem: cloudKeySet(env) ? undefined : "ANTHROPIC_API_KEY is not set." };
}

export function parseRoute(raw: unknown): AiRoute | undefined {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "local" || v === "ollama") return "local";
  if (v === "cloud" || v === "anthropic" || v === "claude") return "cloud";
  if (v === "off" || v === "none" || v === "disabled") return "off";
  return undefined;
}

export interface FeatureRouting {
  /** What actually runs. */
  route: AiRoute;
  /** What was asked for, before degrading. */
  requested: AiRoute;
  /** Who asked: the mode's default, an AI_* env var, or this user's Settings. */
  source: "mode" | "env" | "user";
  /** Why route differs from requested, in words for Settings. */
  note?: string;
}

export interface AiRouting {
  mode: AiMode;
  /** Set when the server cannot run any AI. */
  problem?: string;
  local: AiConfig;
  cloud: AiConfig;
  cloudKeySet: boolean;
  /** The server default for each feature, before user overrides. */
  defaults: Record<AiFeature, AiRoute>;
  features: Record<AiFeature, FeatureRouting>;
  notes: string[];
}

/** Resolves every feature's route from the mode, AI_* env overrides and the user's own choices. */
export function aiRouting(env: Env = process.env, prefs: AiPrefs = {}): AiRouting {
  const { mode, problem } = aiMode(env);
  const local = localConfig(env);
  const cloud = cloudConfig(env);
  const keySet = cloudKeySet(env);
  const defaults = { ...MODE_DEFAULTS[mode] };
  for (const f of AI_FEATURES) {
    const fromEnv = mode === "off" ? undefined : parseRoute(env[FEATURE_ENV[f]]);
    if (fromEnv) defaults[f] = fromEnv;
  }
  const notes: string[] = [];
  const features = {} as Record<AiFeature, FeatureRouting>;
  for (const f of AI_FEATURES) {
    const user = prefs[f] ?? undefined;
    const requested: AiRoute = user ?? defaults[f];
    const source: FeatureRouting["source"] = user ? "user" : parseRoute(env[FEATURE_ENV[f]]) ? "env" : "mode";
    let route = requested;
    let note: string | undefined;
    if (mode === "off") {
      route = "off";
      note = problem;
    } else if (route === "cloud" && mode === "ollama") {
      route = f === "escalation" ? "off" : "local";
      note = "AI_PROVIDER=ollama keeps everything on this machine.";
    } else if (route === "cloud" && !keySet) {
      if (mode === "anthropic") {
        route = "off";
        note = "AI_PROVIDER=anthropic but no ANTHROPIC_API_KEY is set.";
      } else {
        route = f === "escalation" ? "off" : "local";
        note = f === "escalation" ? "No ANTHROPIC_API_KEY, so there is no cloud second opinion." : "No ANTHROPIC_API_KEY, so this runs locally.";
      }
    }
    if (route === "local" && local.problem) {
      route = "off";
      note = local.problem;
    }
    features[f] = { route, requested, source, ...(note ? { note } : {}) };
  }
  // A second opinion only makes sense for a local first pass.
  const esc = features.escalation;
  if (esc.route !== "off" && features.categorize.route !== "local") {
    features.escalation = { ...esc, route: "off", note: features.categorize.route === "cloud" ? "Categorize already runs on the cloud model." : "Categorize is off." };
  }
  if (mode !== "off" && !keySet && mode !== "ollama" && AI_FEATURES.some((f) => features[f].requested === "cloud")) {
    notes.push(
      mode === "anthropic"
        ? "AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY. Cloud features are off until it is set."
        : "ANTHROPIC_API_KEY is not set, so Ledger runs local-only: Insights and chat use Ollama and there are no cloud second opinions. Add the key to .env to turn the cloud half on.",
    );
  }
  if (local.problem && mode !== "off") notes.push(local.problem);
  return { mode, problem, local, cloud, cloudKeySet: keySet, defaults, features, notes };
}

/** Config for one route. */
export function configFor(routing: AiRouting, route: AiRoute): AiConfig {
  if (route === "local") return routing.local;
  if (route === "cloud") return routing.cloud;
  return { provider: "off", model: "", cloud: false, problem: routing.problem ?? "AI is off for this feature." };
}

/**
 * The categorizer's first-pass provider for this server (no user overrides). Kept for callers that
 * only categorize: the CLI, background suggestions, and tests.
 */
export function aiConfig(env: Env = process.env): AiConfig {
  const r = aiRouting(env);
  const c = r.features.categorize;
  if (c.route === "off") return { provider: "off", model: "", cloud: false, problem: r.problem ?? c.note ?? "AI categorization is off on this server." };
  return configFor(r, c.route);
}

/** The server can run some AI feature (the model may still be unreachable right now). */
export function aiConfigured(env: Env = process.env): boolean {
  const r = aiRouting(env);
  return !r.problem && AI_FEATURES.some((f) => r.features[f].route !== "off");
}

/** The user's toggle is on and the server can run AI. */
export async function aiAllowed(userId: string): Promise<boolean> {
  if (!aiConfigured()) return false;
  const u = await db.user.findUnique({ where: { id: userId }, select: { aiConsent: true } });
  return !!u?.aiConsent;
}

export const PREF_FIELDS = { categorize: "aiCategorize", escalation: "aiEscalation", insights: "aiInsights", chat: "aiChat" } as const satisfies Record<AiFeature, string>;

export async function userPrefs(userId: string): Promise<AiPrefs> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { aiCategorize: true, aiEscalation: true, aiInsights: true, aiChat: true } });
  if (!u) return {};
  return Object.fromEntries(AI_FEATURES.map((f) => [f, parseRoute(u[PREF_FIELDS[f]])])) as AiPrefs;
}

/** Routing for one user: server mode and env, then their Settings choices. */
export async function routingFor(userId: string, env: Env = process.env): Promise<AiRouting> {
  return aiRouting(env, await userPrefs(userId));
}

/** Where one feature runs for this user right now; "off" when their AI toggle is off. */
export async function featureRoute(userId: string, feature: AiFeature): Promise<AiRoute> {
  if (!(await aiAllowed(userId))) return "off";
  return (await routingFor(userId)).features[feature].route;
}

/** Saves the user's per-feature choices. null puts a feature back to the server default. */
export async function setUserPrefs(userId: string, prefs: AiPrefs): Promise<void> {
  const data: Record<string, string | null> = {};
  for (const f of AI_FEATURES) {
    if (!(f in prefs)) continue;
    data[PREF_FIELDS[f]] = prefs[f] ?? null;
  }
  if (Object.keys(data).length) await db.user.update({ where: { id: userId }, data });
}

/** True when the Insights chat runs on the cloud model for this user. */
export async function cloudAiAllowed(userId: string): Promise<boolean> {
  return (await featureRoute(userId, "chat")) === "cloud";
}

let client: Anthropic | undefined;
export function anthropic(): Anthropic {
  return (client ??= new Anthropic());
}

/**
 * Which provider served an AI request. Never content: feature, provider, model, outcome, timing and
 * row counts only.
 */
export function logServed(feature: AiFeature, provider: AiProviderName, model: string, outcome: "ok" | "failed" | "rejected", extra: { ms?: number; rows?: number } = {}) {
  log.info("ai.served", { feature, provider, model, outcome, ...extra });
}

export { redactNarration } from "./redact";
