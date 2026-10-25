import { db } from "@/lib/db";
import { AI_FEATURES, aiConfigured, parseRoute, setUserPrefs, type AiPrefs } from "@/core/ai/client";
import { aiSettingsStatus } from "@/core/ai/status";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET: AI status for Settings. Both providers' reachability (`local`, `cloudProvider`; the cloud
 * part says whether ANTHROPIC_API_KEY is set, never the key), where each feature runs (`routes`),
 * notes, and whether AI is on for this account.
 */
export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  return apiJson(await aiSettingsStatus(auth.user.id));
}

/**
 * POST { enabled?: boolean, routes?: { categorize?, escalation?, insights?, chat? } }: the Settings
 * toggle and per-feature choices. Each route is "local", "cloud", "off", or "default" (follow the server).
 */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { enabled, routes } = parsed.body;
  if (enabled === undefined && routes === undefined) return apiError(400, "enabled must be true or false");
  if (enabled !== undefined && typeof enabled !== "boolean") return apiError(400, "enabled must be true or false");
  const prefs: AiPrefs = {};
  if (routes !== undefined) {
    if (!routes || typeof routes !== "object" || Array.isArray(routes)) return apiError(400, "routes must be an object");
    for (const [k, v] of Object.entries(routes as Record<string, unknown>)) {
      if (!(AI_FEATURES as readonly string[]).includes(k)) return apiError(400, `Unknown AI feature "${k}"`);
      const route = v === "default" || v === null ? null : parseRoute(v);
      if (route === undefined) return apiError(400, `${k} must be "local", "cloud", "off" or "default"`);
      prefs[k as keyof AiPrefs] = route;
    }
  }
  if (auth.user.isDemo) return apiError(403, "The demo account cannot change AI settings");
  if (enabled && !aiConfigured()) return apiError(409, "AI is not available on this server");
  if (enabled !== undefined) await db.user.update({ where: { id: auth.user.id }, data: { aiConsent: enabled } });
  await setUserPrefs(auth.user.id, prefs);
  return apiJson(await aiSettingsStatus(auth.user.id));
}
