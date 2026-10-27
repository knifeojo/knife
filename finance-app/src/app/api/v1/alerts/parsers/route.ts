import { apiJson, requireApiUser } from "@/lib/mobile/http";
import { parserRegistryJson } from "@/core/alerts/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  return apiJson(parserRegistryJson());
}
