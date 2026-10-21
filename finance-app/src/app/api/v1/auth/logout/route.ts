import { revokeSessionToken } from "@/lib/auth";
import { apiError, apiJson, bearerToken, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revokes only the token that was presented, so the web session stays signed in. */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const token = bearerToken(req);
  if (!token) return apiError(401, "Sign in required");
  await revokeSessionToken(token);
  return apiJson({ ok: true });
}
