import { db } from "@/lib/db";
import { aiConfigured } from "@/core/ai/client";
import { aiStatus } from "@/core/ai/ollama";
import { backlogCount } from "@/core/ai/categorizer";
import { suggestionCounts } from "@/core/ai/suggestions";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function statusJson(userId: string) {
  const [status, me, counts, backlog] = await Promise.all([
    aiStatus(),
    db.user.findUniqueOrThrow({ where: { id: userId }, select: { aiConsent: true } }),
    suggestionCounts(userId),
    backlogCount(userId),
  ]);
  return {
    provider: status.provider,
    model: status.model,
    cloud: status.cloud,
    reachable: status.reachable,
    modelInstalled: status.modelInstalled,
    message: status.message,
    enabled: me.aiConsent,
    /** False when the server has AI turned off or misconfigured; the toggle cannot be switched on. */
    available: aiConfigured(),
    pendingSuggestions: counts.pending,
    backlog,
  };
}

/** GET: AI status for Settings (provider, model, reachable) and whether it is on for this account. */
export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  return apiJson(await statusJson(auth.user.id));
}

/** POST { enabled: boolean }: the Settings toggle. */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { enabled } = parsed.body;
  if (typeof enabled !== "boolean") return apiError(400, "enabled must be true or false");
  if (auth.user.isDemo) return apiError(403, "The demo account cannot change AI settings");
  if (enabled && !aiConfigured()) return apiError(409, "AI is not available on this server");
  await db.user.update({ where: { id: auth.user.id }, data: { aiConsent: enabled } });
  return apiJson(await statusJson(auth.user.id));
}
