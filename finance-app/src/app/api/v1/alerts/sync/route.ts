import { db } from "@/lib/db";
import { apiError, apiJson, requireApiUser } from "@/lib/mobile/http";
import { syncOneConnection } from "@/core/alerts/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const conns = await db.financialConnection.findMany({
    where: { userId: auth.user.id, status: "active", provider: { in: ["gmail", "imap"] } },
  });
  if (!conns.length) return apiError(404, "No email connection to sync");
  const results = [];
  for (const c of conns) {
    try {
      await syncOneConnection(c.id);
      const fresh = await db.financialConnection.findUniqueOrThrow({ where: { id: c.id } });
      results.push({ id: c.id, provider: c.provider, lastSyncedAt: fresh.lastSyncedAt?.toISOString() ?? null, ok: true });
    } catch (e) {
      results.push({ id: c.id, provider: c.provider, ok: false, error: e instanceof Error ? e.message : "Sync failed" });
    }
  }
  return apiJson({ results });
}
