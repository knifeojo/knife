import { db } from "@/lib/db";
import { backlogCount } from "./categorizer";
import { AI_FEATURES, FEATURE_LABELS, aiConfigured, routingFor, type AiFeature, type AiMode, type AiRoute, type FeatureRouting } from "./client";
import { cloudStatus, type CloudStatus } from "./cloud";
import { aiStatus, type Fetch } from "./ollama";
import { suggestionCounts } from "./suggestions";

// What Settings (web and phone) shows about AI: both providers' reachability, where each feature
// runs and why, and the user's toggle. Never includes the API key, only whether one is set.

export interface LocalStatus {
  provider: "ollama";
  model: string;
  baseUrl?: string;
  reachable: boolean;
  modelInstalled: boolean;
  message: string;
}

export type RouteStatus = FeatureRouting & { label: string; serverDefault: AiRoute };

export interface AiSettingsStatus {
  /** The categorizer's provider (kept for older phone builds). */
  provider: "ollama" | "anthropic" | "off";
  model: string;
  /** True when at least one feature sends redacted data to the cloud model. */
  cloud: boolean;
  reachable: boolean;
  modelInstalled: boolean;
  message: string;
  enabled: boolean;
  /** False when the server has AI turned off or misconfigured; the toggle cannot be switched on. */
  available: boolean;
  pendingSuggestions: number;
  backlog: number;
  mode: AiMode;
  routes: Record<AiFeature, RouteStatus>;
  local: LocalStatus;
  cloudProvider: CloudStatus;
  notes: string[];
}

export async function aiSettingsStatus(userId: string, deps: { fetch?: Fetch; cloudCheck?: () => Promise<unknown> } = {}): Promise<AiSettingsStatus> {
  const routing = await routingFor(userId);
  const [local, cloud, me, counts, backlog] = await Promise.all([
    aiStatus({ config: routing.local, fetch: deps.fetch }),
    cloudStatus({ check: deps.cloudCheck }),
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { aiConsent: true } }),
    suggestionCounts(userId),
    backlogCount(userId),
  ]);
  const routes = Object.fromEntries(
    AI_FEATURES.map((f) => [f, { ...routing.features[f], label: FEATURE_LABELS[f], serverDefault: routing.defaults[f] }]),
  ) as Record<AiFeature, RouteStatus>;
  const cat = routing.features.categorize.route;
  const categorizer =
    cat === "local" ? { provider: "ollama" as const, model: local.model, reachable: local.reachable, modelInstalled: local.modelInstalled, message: local.message }
    : cat === "cloud" ? { provider: "anthropic" as const, model: cloud.model, reachable: cloud.reachable, modelInstalled: cloud.reachable, message: cloud.message }
    : { provider: "off" as const, model: "", reachable: false, modelInstalled: false, message: routing.problem ?? routing.features.categorize.note ?? "AI categorization is off." };
  return {
    ...categorizer,
    cloud: AI_FEATURES.some((f) => routing.features[f].route === "cloud"),
    enabled: me.aiConsent,
    available: aiConfigured(),
    pendingSuggestions: counts.pending,
    backlog,
    mode: routing.mode,
    routes,
    local: { provider: "ollama", model: local.model, baseUrl: local.baseUrl, reachable: local.reachable, modelInstalled: local.modelInstalled, message: local.message },
    cloudProvider: cloud,
    notes: routing.notes,
  };
}
