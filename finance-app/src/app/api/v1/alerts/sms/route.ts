import { ingestPushPayload, ingestSmsPayload } from "@/core/alerts/ingest";
import { apiError, apiJson, readJsonObject } from "@/lib/mobile/http";
import { requireAlertUser } from "@/lib/mobile/sms-auth";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireAlertUser(req);
  if ("response" in auth) return auth.response;
  const limited = rateLimit(`sms:${auth.userId}:${clientIp(req)}`, 60, 60_000);
  if (!limited.allowed) return apiError(429, "Too many alerts; try again shortly.");
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const messages = Array.isArray(body.messages) ? body.messages : [body];
  if (messages.length > 200) return apiError(400, "Send at most 200 messages at once.");
  const results = [];
  for (const item of messages) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.sender !== "string" || typeof row.body !== "string") return apiError(400, "Each message needs sender and body");
    if (row.sender.length > 80 || row.body.length > 4000) return apiError(400, "Message is too large");
    try {
      const payload = {
        sender: row.sender,
        body: row.body,
        receivedAt: typeof row.receivedAt === "string" ? row.receivedAt : undefined,
        sourceId: typeof row.sourceId === "string" ? row.sourceId : undefined,
      };
      results.push(await (row.channel === "push" ? ingestPushPayload(auth.userId, payload) : ingestSmsPayload(auth.userId, payload)));
    } catch (e) {
      return apiError(400, e instanceof Error ? e.message : "Could not ingest SMS");
    }
  }
  return apiJson({ results });
}
