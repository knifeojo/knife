import { MAX_STATEMENT_BYTES, StatementFormatError, importStatement, isPasswordError, type StatementImportSummary } from "../statement-import";
import { queueStatementFile, readQueuedStatement, statementHash } from "../statements/files";
import { saveStatementPassword } from "../statements/passwords";
import type { EmailAttachment } from "../types";
import { isStatementAttachment } from "./attachments";
import { detectStatementEmail } from "./statement-mail";

export interface EmailStatementResult {
  file: string;
  status: "imported" | "needs_password" | "unrecognised" | "duplicate";
  institution?: string;
  created?: number;
}

/**
 * Import statement attachments from one email through the same pipeline as POST /api/v1/statements.
 * Alert bodies are left to the alert parser. Passwords are never logged and never sent to a model.
 */
export async function importEmailAttachments(userId: string, msg: {
  source: string;
  messageId: string;
  from: string;
  subject: string;
  attachments?: EmailAttachment[];
  fetchAttachment?: (attachmentId: string) => Promise<Buffer>;
}): Promise<EmailStatementResult[]> {
  const listed = msg.attachments ?? [];
  const filenames = listed.map((item) => item.filename).filter(Boolean);
  const detected = detectStatementEmail({ from: msg.from, subject: msg.subject, filenames });
  if (!detected) return [];

  const results: EmailStatementResult[] = [];
  for (const attachment of listed) {
    if (!isStatementAttachment(attachment.filename, attachment.mimeType)) continue;
    const bytes = await bytesOf(attachment, msg.fetchAttachment);
    if (!bytes) continue;
    results.push(await importOne(userId, {
      source: msg.source,
      messageId: msg.messageId,
      from: msg.from,
      subject: msg.subject,
      institution: detected.institution,
      filename: attachment.filename,
      bytes,
    }));
  }
  if (results.some((result) => result.status === "imported")) {
    const { suggestInBackground } = await import("../ai/categorizer");
    suggestInBackground(userId);
  }
  return results;
}

async function bytesOf(attachment: EmailAttachment, fetchAttachment?: (attachmentId: string) => Promise<Buffer>): Promise<Buffer | undefined> {
  if (attachment.bytes?.length) return attachment.bytes;
  if (attachment.attachmentId && fetchAttachment) {
    const fetched = await fetchAttachment(attachment.attachmentId);
    return fetched.length ? fetched : undefined;
  }
  return undefined;
}

async function importOne(userId: string, input: {
  source: string;
  messageId: string;
  from: string;
  subject: string;
  institution: string;
  filename: string;
  bytes: Buffer;
}): Promise<EmailStatementResult> {
  const file = input.filename.slice(0, 120) || "statement";
  if (input.bytes.length > MAX_STATEMENT_BYTES) {
    await queueStatementFile(userId, {
      fileName: file,
      contentHash: statementHash(input.bytes),
      institution: input.institution,
      source: input.source,
      messageId: input.messageId,
      sender: input.from,
      subject: input.subject,
      status: "unrecognised",
      detail: "File is larger than 5 MB.",
    });
    return { file, status: "unrecognised", institution: input.institution };
  }
  try {
    const summary = await importStatement(userId, { name: file, bytes: input.bytes }, {
      institution: input.institution,
      source: input.source,
      messageId: input.messageId,
      sender: input.from,
      subject: input.subject,
    });
    const status = summary.fileStatus === "duplicate" || summary.fileStatus === "unrecognised" ? summary.fileStatus : "imported";
    return { file, status, institution: summary.institution, created: summary.created + (summary.others ?? []).reduce((sum, item) => sum + item.created, 0) };
  } catch (e) {
    const contentHash = statementHash(input.bytes);
    if (isPasswordError(e)) {
      await queueStatementFile(userId, {
        bytes: input.bytes,
        fileName: file,
        contentHash,
        institution: input.institution,
        source: input.source,
        messageId: input.messageId,
        sender: input.from,
        subject: input.subject,
        status: "needs_password",
        detail: "This statement needs a password. Enter it in Review. You can remember it for this bank.",
      });
      return { file, status: "needs_password", institution: input.institution };
    }
    const detail = e instanceof StatementFormatError ? e.message : "Could not read this statement.";
    await queueStatementFile(userId, {
      fileName: file,
      contentHash,
      institution: input.institution,
      source: input.source,
      messageId: input.messageId,
      sender: input.from,
      subject: input.subject,
      status: "unrecognised",
      detail,
    });
    return { file, status: "unrecognised", institution: input.institution };
  }
}

export async function unlockStatement(userId: string, id: string, password: string, opts: { remember?: boolean } = {}): Promise<{ ok: true; summary: StatementImportSummary } | { error: string }> {
  const queued = await readQueuedStatement(userId, id);
  if (!queued) return { error: "That statement is no longer waiting for a password." };
  const typed = password.slice(0, 200);
  if (!typed) return { error: "Enter the statement password." };
  try {
    const summary = await importStatement(userId, { name: queued.fileName, bytes: queued.bytes }, {
      institution: queued.institution ?? undefined,
      password: typed,
      source: "review",
    });
    if (opts.remember && queued.institution) saveStatementPassword(userId, queued.institution, typed);
    return { ok: true, summary };
  } catch (e) {
    if (isPasswordError(e)) return { error: "That password did not open the statement." };
    if (e instanceof StatementFormatError) return { error: e.message };
    return { error: "Could not read this statement." };
  }
}
