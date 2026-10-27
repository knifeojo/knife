import { db } from "@/lib/db";
import { resolveUnparsed } from "@/core/alerts/ingest";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const [unparsed, gaps, flags] = await Promise.all([
    db.unparsedAlert.findMany({ where: { userId: auth.user.id, status: "open" }, orderBy: { receivedAt: "desc" }, take: 50 }),
    db.balanceGap.findMany({ where: { userId: auth.user.id, status: "open" }, orderBy: { atDate: "desc" }, take: 50 }),
    db.reconFlag.findMany({ where: { userId: auth.user.id, status: "open" }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  return apiJson({
    unparsed: unparsed.map((u) => ({
      id: u.id, channel: u.channel, sender: u.sender, receivedAt: u.receivedAt.toISOString(), reason: u.reason, parser: u.parser, rawText: u.rawText,
    })),
    gaps: gaps.map((g) => ({
      id: g.id, accountId: g.accountId, expectedMinor: g.expectedMinor.toString(), actualMinor: g.actualMinor.toString(), gapMinor: g.gapMinor.toString(), atDate: g.atDate.toISOString(),
    })),
    flags: flags.map((f) => ({ id: f.id, kind: f.kind, detail: f.detail, transactionId: f.transactionId })),
  });
}

export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { id, action, kind } = parsed.body;
  if (typeof id !== "string") return apiError(400, "id is required");
  if (kind === "gap") {
    await db.balanceGap.updateMany({ where: { id, userId: auth.user.id }, data: { status: "dismissed" } });
    return apiJson({ ok: true });
  }
  if (kind === "flag") {
    await db.reconFlag.updateMany({ where: { id, userId: auth.user.id }, data: { status: "dismissed" } });
    return apiJson({ ok: true });
  }
  if (action !== "ignore" && action !== "add") return apiError(400, "action must be add or ignore");
  const result = await resolveUnparsed(auth.user.id, id, action);
  if ("error" in result) return apiError(400, result.error);
  return apiJson({ ok: true });
}
