import { removeEmailConnection } from "@/core/email/inboxes";
import { apiError, apiJson, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const removed = await removeEmailConnection(auth.user.id, id);
  if (!removed) return apiError(404, "That inbox is not connected.");
  return apiJson({ ok: true });
}
