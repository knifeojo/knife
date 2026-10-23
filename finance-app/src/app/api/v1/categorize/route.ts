import { reapplyCategories, reapplyMessage } from "@/core/ledger";
import { apiJson, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST: "Re-run categorization", the same as the web Settings button. Labels the user chose are kept. */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const r = await reapplyCategories(auth.user.id);
  return apiJson({ checked: r.checked, changed: r.changed, message: reapplyMessage(r) });
}
