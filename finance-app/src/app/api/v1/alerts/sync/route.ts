import { db } from "@/lib/db";
import { apiJson, requireApiUser } from "@/lib/mobile/http";
import { syncOneConnection } from "@/core/alerts/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Same work as the web Sync now button: Gmail and IMAP for the signed-in user. Always a summary, including when nothing is connected. */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const conns = await db.financialConnection.findMany({
    where: { userId: auth.user.id, status: "active", provider: { in: ["gmail", "imap"] } },
  });
  const totals = { emailsScanned: 0, created: 0, duplicates: 0, parseFailures: 0, skipped: 0 };
  const results: Array<Record<string, unknown>> = [];
  for (const c of conns) {
    try {
      const summary = await syncOneConnection(c.id);
      const fresh = await db.financialConnection.findUniqueOrThrow({ where: { id: c.id } });
      if (summary) {
        totals.emailsScanned += summary.emailsScanned;
        totals.created += summary.created;
        totals.duplicates += summary.duplicates;
        totals.parseFailures += summary.parseFailures;
        totals.skipped += summary.skipped;
      }
      results.push({
        id: c.id,
        provider: c.provider,
        ok: true,
        lastSyncedAt: fresh.lastSyncedAt?.toISOString() ?? null,
        emailsScanned: summary?.emailsScanned ?? 0,
        created: summary?.created ?? 0,
        duplicates: summary?.duplicates ?? 0,
        parseFailures: summary?.parseFailures ?? 0,
      });
    } catch (e) {
      results.push({ id: c.id, provider: c.provider, ok: false, error: e instanceof Error ? e.message : "Sync failed" });
    }
  }
  const failed = results.some((r) => r.ok === false);
  const message = !conns.length
    ? "No email connection to sync."
    : failed
      ? "Email sync finished with an error."
      : totals.emailsScanned === 0
        ? "Up to date. No new alerts since the last sync."
        : `Scanned ${totals.emailsScanned} emails: ${totals.created} new transactions, ${totals.duplicates} duplicates merged, ${totals.parseFailures} could not be parsed.`;
  return apiJson({ ok: !failed, message, ...totals, results });
}
