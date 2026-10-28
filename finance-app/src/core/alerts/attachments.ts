import { simpleParser } from "mailparser";
import type { EmailAttachment } from "../types";

// Pull PDF, CSV and XLSX attachments out of Gmail payloads, IMAP/MIME messages, and
// forwarding-inbox JSON (Postmark, Cloudflare Email Workers, generic). Other types are ignored.

const SPREADSHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function attachmentExtension(filename: string): string {
  const base = filename.split(/[/\\]/).pop()?.split("?")[0]?.trim().toLowerCase() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1) : "";
}

export function isStatementAttachment(filename: string, mimeType: string): boolean {
  const ext = attachmentExtension(filename);
  if (ext === "xls") return false;
  if (ext === "pdf" || ext === "csv" || ext === "xlsx") return true;
  const mime = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  return mime === "application/pdf" || mime === "text/csv" || mime === "application/csv" || mime === SPREADSHEET;
}

export function fallbackAttachmentName(filename: string, mimeType: string): string {
  const clean = filename.split(/[/\\]/).pop()?.split("?")[0]?.trim();
  if (clean) return clean.slice(0, 120);
  const mime = mimeType.toLowerCase();
  if (mime.includes("pdf")) return "statement.pdf";
  if (mime.includes("spreadsheet") || mime.includes("excel")) return "statement.xlsx";
  return "statement.csv";
}

export function decodeAttachmentContent(content: string): Buffer {
  const compact = content.replace(/\s+/g, "");
  const looksB64 = compact.length >= 8 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  if (looksB64) {
    const buf = Buffer.from(compact, "base64");
    if (buf.length > 0) return buf;
  }
  return Buffer.from(content, "utf8");
}

interface GmailPart {
  filename?: string;
  mimeType?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

/** Walk a Gmail `format=full` payload. Inline parts include bytes; larger parts keep attachmentId. */
export function attachmentsFromGmailPayload(payload: unknown): EmailAttachment[] {
  const out: EmailAttachment[] = [];
  const walk = (part: GmailPart | undefined) => {
    if (!part) return;
    const filename = part.filename?.trim() ?? "";
    const mimeType = part.mimeType ?? "";
    if ((filename || part.body?.attachmentId || part.body?.data) && isStatementAttachment(filename, mimeType)) {
      const name = fallbackAttachmentName(filename, mimeType);
      if (part.body?.data) {
        const bytes = Buffer.from(part.body.data, "base64url");
        if (bytes.length) out.push({ filename: name, mimeType, bytes });
      } else if (part.body?.attachmentId) {
        out.push({ filename: name, mimeType, attachmentId: part.body.attachmentId });
      }
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload as GmailPart);
  return out;
}

/** Headers + body of a Gmail users.messages resource, without fetching attachment bytes. */
export function emailFieldsFromGmailResource(msg: {
  id?: string;
  internalDate?: string;
  payload?: unknown;
}): { id: string; from: string; subject: string; date: Date; text?: string; html?: string; attachments: EmailAttachment[] } {
  const headers = ((msg.payload as { headers?: { name: string; value: string }[] } | undefined)?.headers) ?? [];
  const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  const bodies: { html?: string; text?: string } = {};
  collectBodies(msg.payload as GmailPart | undefined, bodies);
  const internal = Number(msg.internalDate);
  return {
    id: msg.id ?? "",
    from: header("from"),
    subject: header("subject"),
    date: Number.isFinite(internal) ? new Date(internal) : new Date(),
    ...bodies,
    attachments: attachmentsFromGmailPayload(msg.payload),
  };
}

function collectBodies(part: GmailPart | undefined, out: { html?: string; text?: string }) {
  if (!part) return;
  const data = part.body?.data ? Buffer.from(part.body.data, "base64url").toString("utf8") : undefined;
  if (data && part.mimeType === "text/html" && !out.html) out.html = data;
  if (data && part.mimeType === "text/plain" && !out.text) out.text = data;
  for (const child of part.parts ?? []) collectBodies(child, out);
}

export function attachmentsFromMailparser(attachments: { filename?: string | false | null; contentType?: string; content?: Buffer }[] | undefined): EmailAttachment[] {
  const out: EmailAttachment[] = [];
  for (const item of attachments ?? []) {
    const filename = typeof item.filename === "string" ? item.filename : "";
    const mimeType = item.contentType ?? "";
    if (!item.content?.length || !isStatementAttachment(filename, mimeType)) continue;
    out.push({ filename: fallbackAttachmentName(filename, mimeType), mimeType, bytes: item.content });
  }
  return out;
}

function mimeBuffer(raw: string): Buffer {
  const trimmed = raw.trim();
  const compact = trimmed.replace(/\s+/g, "");
  const looksB64 = compact.length >= 16 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact) && !/^from:/i.test(trimmed) && !/^content-type:/i.test(trimmed);
  if (looksB64) return Buffer.from(compact, "base64");
  return Buffer.from(trimmed, "utf8");
}

/** RFC822 (or base64 of it), as Cloudflare's `raw` field or a .eml. */
export async function attachmentsFromMime(raw: string | Buffer): Promise<EmailAttachment[]> {
  const source = typeof raw === "string" ? mimeBuffer(raw) : raw;
  if (!source.length) return [];
  const parsed = await simpleParser(source);
  return attachmentsFromMailparser(parsed.attachments);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Postmark `Attachments`, or a generic/Cloudflare `attachments` array. Content is base64 or raw text. */
export function attachmentsFromList(value: unknown): EmailAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: EmailAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const filename = str(rec.Name) ?? str(rec.filename) ?? str(rec.fileName) ?? str(rec.name) ?? "";
    const mimeType = str(rec.ContentType) ?? str(rec.contentType) ?? str(rec.mimeType) ?? str(rec.type) ?? "";
    const content = str(rec.Content) ?? str(rec.content) ?? str(rec.data) ?? str(rec.base64);
    if (!content || !isStatementAttachment(filename, mimeType)) continue;
    const bytes = decodeAttachmentContent(content);
    if (!bytes.length) continue;
    out.push({ filename: fallbackAttachmentName(filename, mimeType), mimeType, bytes });
  }
  return out;
}

export async function attachmentsFromInboundRaw(body: Record<string, unknown>): Promise<EmailAttachment[]> {
  const raw = body.raw ?? body.RawEmail ?? body.rfc822;
  if (typeof raw !== "string" || !raw.trim()) return [];
  if (Buffer.isBuffer(raw)) return attachmentsFromMime(raw);
  return attachmentsFromMime(raw);
}
