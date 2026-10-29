import { db } from "@/lib/db";
import { heldAlertPreview, isPossiblyAnotherAccount, POSSIBLY_ANOTHER_ACCOUNT } from "@/core/alerts/account-attach";
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
      id: u.id,
      channel: u.channel,
      sender: u.sender,
      receivedAt: u.receivedAt.toISOString(),
      reason: isPossiblyAnotherAccount(u.reason) ? POSSIBLY_ANOTHER_ACCOUNT : u.reason,
      parser: u.parser,
      rawText: isPossiblyAnotherAccount(u.reason) ? heldAlertPreview(u.rawText) : u.rawText,
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
  if (action !== "ignore" && action !== "add" && action !== "attach" && action !== "create") {
    return apiError(400, "action must be add, ignore, attach, or create");
  }
  const accountId = typeof parsed.body.accountId === "string" ? parsed.body.accountId : undefined;
  const result = await resolveUnparsed(auth.user.id, id, action, { accountId });
  if ("error" in result) return apiError(400, result.error);
  return apiJson({ ok: true });
}
