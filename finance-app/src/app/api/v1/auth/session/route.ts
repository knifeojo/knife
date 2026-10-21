import { apiJson, publicUser, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  return apiJson({ user: publicUser(auth.user), expiresAt: auth.expiresAt.toISOString() });
}
