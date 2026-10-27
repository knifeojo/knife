import { db } from "@/lib/db";
import { apiJson, requireApiUser } from "@/lib/mobile/http";
import { defaultSyncMinutes } from "@/core/alerts/secrets";
import { ensureUserTokens, inboundAddress } from "@/core/alerts/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const tokens = await ensureUserTokens(auth.user.id);
  const connections = await db.financialConnection.findMany({
    where: { userId: auth.user.id, status: { not: "revoked" } },
    select: { id: true, provider: true, providerAccountId: true, status: true, lastSyncedAt: true, lastError: true, imapHost: true, imapUser: true, syncIntervalMinutes: true },
  });
  const [unparsed, gaps, notices] = await Promise.all([
    db.unparsedAlert.count({ where: { userId: auth.user.id, status: "open" } }),
    db.balanceGap.count({ where: { userId: auth.user.id, status: "open" } }),
    db.forwardingNotice.findMany({ where: { userId: auth.user.id, status: "new" }, orderBy: { receivedAt: "desc" }, take: 3 }),
  ]);
  const lastSyncedAt = connections.reduce<Date | null>((acc, c) => {
    if (!c.lastSyncedAt) return acc;
    if (!acc || c.lastSyncedAt > acc) return c.lastSyncedAt;
    return acc;
  }, null);
  return apiJson({
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
    syncIntervalMinutes: defaultSyncMinutes(),
    inboundAddress: inboundAddress(tokens.inboundEmailToken),
    inboundToken: tokens.inboundEmailToken,
    smsToken: tokens.smsIngestToken,
    unparsedCount: unparsed,
    gapCount: gaps,
    forwarding: notices.map((n) => ({ id: n.id, code: n.code, link: n.link, subject: n.subject, receivedAt: n.receivedAt.toISOString() })),
    connections: connections.map((c) => ({
      id: c.id,
      provider: c.provider,
      account: c.providerAccountId,
      status: c.status,
      lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
      lastError: c.lastError,
      imapHost: c.imapHost,
      imapUser: c.imapUser,
      syncIntervalMinutes: c.syncIntervalMinutes,
    })),
  });
}
