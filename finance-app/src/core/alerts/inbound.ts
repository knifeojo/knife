import { createHmac, timingSafeEqual } from "node:crypto";
import type { EmailAttachment } from "../types";
import { attachmentsFromList } from "./attachments";
import { detectGmailForwardingConfirmation } from "./confirmation";
import { inboundEmailSecret } from "./secrets";
import { tokenFromRecipient } from "./tokens";

export interface InboundEmail {
  to: string;
  from: string;
  subject: string;
  text?: string;
  html?: string;
  date?: string;
  messageId?: string;
  attachments?: EmailAttachment[];
}

export function verifyInboundSecret(req: Request, rawBody: string): boolean {
  const expected = inboundEmailSecret();
  if (!expected) return false;
  const header =
    req.headers.get("x-inbound-secret") ??
    req.headers.get("x-postmark-webhook-token") ??
    bearer(req.headers.get("authorization"));
  if (header && safeEqual(header, expected)) return true;
  const sig = req.headers.get("x-postmark-signature");
  if (sig) {
    const digest = createHmac("sha256", expected).update(rawBody).digest("base64");
    return safeEqual(sig, digest);
  }
  return false;
}

function bearer(value: string | null): string | null {
  if (!value) return null;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m?.[1] ?? null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function parseGenericInbound(body: Record<string, unknown>): InboundEmail | null {
  const to = str(body.to) ?? str(body.recipient) ?? firstTo(body.toFull);
  const from = str(body.from) ?? str(body.sender);
  if (!to || !from) return null;
  const attachments = attachmentsFromList(body.attachments ?? body.Attachments);
  return {
    to,
    from,
    subject: str(body.subject) ?? "",
    text: str(body.text) ?? str(body.textBody) ?? str(body["text-plain"]),
    html: str(body.html) ?? str(body.htmlBody),
    date: str(body.date) ?? str(body.timestamp),
    messageId: str(body.messageId) ?? str(body.MessageID),
    ...(attachments.length ? { attachments } : {}),
  };
}

/** Cloudflare Email Workers payload: { to, from, subject, text?, html?, raw?, headers? }. */
export function parseCloudflareInbound(body: Record<string, unknown>): InboundEmail | null {
  return parseGenericInbound({
    to: body.to ?? body.recipient,
    from: body.from,
    subject: body.subject ?? header(body, "subject"),
    text: body.text,
    html: body.html,
    date: body.date ?? header(body, "date"),
    messageId: body.messageId ?? header(body, "message-id"),
    attachments: body.attachments ?? body.Attachments,
  });
}

/** Postmark inbound JSON. */
export function parsePostmarkInbound(body: Record<string, unknown>): InboundEmail | null {
  const toFull = body.ToFull;
  const first = Array.isArray(toFull) && toFull[0] && typeof toFull[0] === "object" ? (toFull[0] as { Email?: string }).Email : undefined;
  return parseGenericInbound({
    to: str(body.OriginalRecipient) ?? first ?? str(body.To),
    from: str(body.FromFull) ? String((body.FromFull as { Email?: string }).Email ?? body.From) : body.From,
    subject: body.Subject,
    text: body.TextBody,
    html: body.HtmlBody,
    date: body.Date,
    messageId: body.MessageID,
    attachments: body.Attachments ?? body.attachments,
  });
}

export function adaptInbound(body: Record<string, unknown>): InboundEmail | null {
  if (body.TextBody || body.ToFull || body.MessageID) return parsePostmarkInbound(body);
  if (body.personalizations || body.raw) return parseCloudflareInbound(body);
  return parseGenericInbound(body) ?? parseCloudflareInbound(body);
}

export function inboundTokenOf(email: InboundEmail): string | undefined {
  return tokenFromRecipient(email.to);
}

export function inboundConfirmation(email: InboundEmail) {
  return detectGmailForwardingConfirmation({ subject: email.subject, text: email.text, html: email.html });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function firstTo(v: unknown): string | undefined {
  if (Array.isArray(v) && v[0]) return str((v[0] as { Email?: string; email?: string }).Email ?? (v[0] as { email?: string }).email ?? v[0]);
  return undefined;
}

function header(body: Record<string, unknown>, name: string): string | undefined {
  const headers = body.headers;
  if (!headers || typeof headers !== "object") return undefined;
  const rec = headers as Record<string, unknown>;
  const direct = rec[name] ?? rec[name.toLowerCase()];
  return str(direct);
}
