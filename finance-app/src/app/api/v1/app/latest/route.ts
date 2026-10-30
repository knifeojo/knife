import { loadReadyRelease } from "@/core/app-release";
import { apiError, apiJson, clientIp, requireApiUser } from "@/lib/mobile/http";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Session bearer only. Returns the published APK manifest, or 404 when nothing is ready. */
export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const limited = rateLimit(`app-latest:${auth.user.id}:${clientIp(req)}`, 30, 60_000);
  if (!limited.allowed) return apiError(429, "Too many update checks; try again shortly.");
  const ready = loadReadyRelease();
  if (!ready) return apiError(404, "No app release yet");
  const { version, buildNumber, sha256, size } = ready.release;
  return apiJson({ version, buildNumber, sha256, size });
}
