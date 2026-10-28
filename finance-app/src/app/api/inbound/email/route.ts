import { db } from "@/lib/db";
import { apiError, apiJson } from "@/lib/mobile/http";
import { attachmentsFromInboundRaw } from "@/core/alerts/attachments";
import { adaptInbound, inboundConfirmation, inboundTokenOf, verifyInboundSecret } from "@/core/alerts/inbound";
import { importEmailAttachments } from "@/core/alerts/import-statements";
import { ingestAlertMessage } from "@/core/alerts/ingest";
import { emailToAlert } from "@/core/alerts/email-adapter";
import { userIdForInboundToken } from "@/core/alerts/tokens";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyInboundSecret(req, raw)) return apiError(401, "Unauthorized");
  const limited = rateLimit(`inbound:${clientIp(req)}`, 120, 60_000);
  if (!limited.allowed) return apiError(429, "Too many inbound emails");
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return apiError(400, "Send JSON");
  }
  const email = adaptInbound(json);
  if (!email) return apiError(400, "Could not read this inbound payload");
  const token = inboundTokenOf(email);
  if (!token) return apiError(400, "Recipient is not an alerts-<token> address");
  const userId = await userIdForInboundToken(token);
  if (!userId) return apiError(404, "Unknown inbound address");

  const confirm = inboundConfirmation(email);
  if (confirm) {
    await db.forwardingNotice.create({
      data: { userId, code: confirm.code, link: confirm.link, subject: email.subject.slice(0, 200), receivedAt: email.date ? new Date(email.date) : new Date() },
    });
    return apiJson({ confirmation: true, code: confirm.code ?? null, link: confirm.link ?? null });
  }

  if (!email.attachments?.length) {
    try {
      email.attachments = await attachmentsFromInboundRaw(json);
    } catch {
      email.attachments = [];
    }
  }
  const messageId = email.messageId ?? `inbound-${Date.now()}`;
  const msg = emailToAlert({
    id: messageId,
    from: email.from,
    subject: email.subject,
    date: email.date ? new Date(email.date) : new Date(),
    text: email.text,
    html: email.html,
  });
  const result = await ingestAlertMessage(userId, msg, { source: "inbound", sourceId: email.messageId });
  const statements = await importEmailAttachments(userId, {
    source: "inbound",
    messageId,
    from: email.from,
    subject: email.subject,
    attachments: email.attachments,
  });
  return apiJson(statements.length ? { ...result, statements } : result);
}
