import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { StatementImportSummary } from "../statement-import";
import { openBytes, sealBytes } from "./passwords";

// Idempotency for statement files: the same bytes are never imported twice, and a different
// file whose dates sit inside an already-imported statement for the same account is a duplicate
// when it adds no rows. Row-level fingerprints still run for any file we do import.

export type StatementFileStatus = "imported" | "needs_password" | "unrecognised" | "duplicate";
export type PeriodOverlap = "none" | "overlap" | "contained";

export function statementHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function accountKeyOf(institution: string, last4?: string | null, currency?: string): string {
  const digits = (last4 ?? "").replace(/\D/g, "").slice(-4);
  return `${institution.trim().toLowerCase()}|${digits}|${(currency ?? "").toUpperCase()}`;
}

export function periodOverlap(nextFrom: Date, nextTo: Date, existingFrom: Date, existingTo: Date): PeriodOverlap {
  const overlaps = nextFrom.getTime() <= existingTo.getTime() && nextTo.getTime() >= existingFrom.getTime();
  if (!overlaps) return "none";
  if (nextFrom.getTime() >= existingFrom.getTime() && nextTo.getTime() <= existingTo.getTime()) return "contained";
  return "overlap";
}

export function statementFileStatus(input: { created: number; overlap: PeriodOverlap }): "imported" | "duplicate" {
  if (input.created === 0 && input.overlap !== "none") return "duplicate";
  return "imported";
}

export function strongestOverlap(kinds: PeriodOverlap[]): PeriodOverlap {
  if (kinds.includes("contained")) return "contained";
  if (kinds.includes("overlap")) return "overlap";
  return "none";
}

function asDuplicate(summary: StatementImportSummary): StatementImportSummary {
  const dup = (item: StatementImportSummary): StatementImportSummary => ({
    ...item,
    created: 0,
    duplicates: item.created + item.duplicates,
    errors: [],
    fileStatus: "duplicate",
  });
  const top = dup(summary);
  if (summary.others?.length) top.others = summary.others.map((item) => dup(item));
  return top;
}

export function replaySummary(row: { replayJson: string | null; institution: string | null; currency: string | null; rowsRead: number; transactionCount: number; accountLast4: string | null; balanceBreaks: number; gap: string | null; complete: boolean }): StatementImportSummary {
  if (row.replayJson) {
    try {
      return asDuplicate(JSON.parse(row.replayJson) as StatementImportSummary);
    } catch {
      // Fall through to the columns.
    }
  }
  return {
    institution: row.institution ?? "Unknown bank",
    currency: row.currency ?? "NGN",
    rowsRead: row.rowsRead,
    created: 0,
    duplicates: row.transactionCount,
    errors: [],
    accountLast4: row.accountLast4 ?? undefined,
    balanceBreaks: row.balanceBreaks,
    gap: row.gap,
    complete: row.complete,
    fileStatus: "duplicate",
  };
}

export async function overlapWithImported(userId: string, contentHash: string, accountKey: string | null, from?: Date | null, to?: Date | null): Promise<PeriodOverlap> {
  if (!accountKey || !from || !to) return "none";
  const others = await db.statementFile.findMany({
    where: {
      userId,
      accountKey,
      contentHash: { not: contentHash },
      status: { in: ["imported", "duplicate"] },
      periodFrom: { not: null },
      periodTo: { not: null },
    },
    select: { periodFrom: true, periodTo: true },
  });
  return strongestOverlap(others.map((row) => periodOverlap(from, to, row.periodFrom!, row.periodTo!)));
}

async function statementConnection(userId: string) {
  return db.financialConnection.upsert({
    where: { userId_provider: { userId, provider: "statement" } },
    update: {},
    create: { userId, provider: "statement", providerAccountId: "Statement uploads" },
  });
}

export async function markStatementDuplicate(id: string, touch: { source?: string; messageId?: string; sender?: string; subject?: string }) {
  await db.statementFile.update({
    where: { id },
    data: {
      status: "duplicate",
      occurrences: { increment: 1 },
      encryptedBytes: null,
      bytesStored: false,
      ...(touch.source ? { source: touch.source } : {}),
      ...(touch.messageId ? { messageId: touch.messageId.slice(0, 200) } : {}),
      ...(touch.sender ? { sender: touch.sender.slice(0, 200) } : {}),
      ...(touch.subject ? { subject: touch.subject.slice(0, 200) } : {}),
    },
  });
}

export async function recordImportedStatement(userId: string, input: {
  contentHash: string;
  fileName: string;
  summary: StatementImportSummary;
  transactionCount: number;
  periodFrom?: Date;
  periodTo?: Date;
  source?: string;
  messageId?: string;
  sender?: string;
  subject?: string;
}): Promise<Exclude<StatementFileStatus, "needs_password">> {
  const institution = input.summary.institution;
  const accountKey = accountKeyOf(institution, input.summary.accountLast4, input.summary.currency);
  const overlap = await overlapWithImported(userId, input.contentHash, accountKey, input.periodFrom, input.periodTo);
  const sections = [input.summary, ...(input.summary.others ?? [])];
  const created = sections.reduce((sum, item) => sum + item.created, 0);
  const duplicates = sections.reduce((sum, item) => sum + item.duplicates, 0);
  const errorCount = sections.reduce((sum, item) => sum + item.errors.length, 0);
  const layoutFailed = input.transactionCount === 0 && created === 0 && duplicates === 0 && errorCount > 0;
  const status = layoutFailed ? "unrecognised" : statementFileStatus({ created, overlap });
  const replay = JSON.stringify({ ...input.summary, fileStatus: status });
  const data = {
    fileName: input.fileName.slice(0, 160),
    institution,
    accountKey,
    periodFrom: input.periodFrom ?? null,
    periodTo: input.periodTo ?? null,
    status,
    detail: layoutFailed ? (input.summary.errors[0]?.reason ?? "Unrecognised layout").slice(0, 300) : null,
    rowsRead: input.summary.rowsRead,
    transactionCount: input.transactionCount,
    accountLast4: input.summary.accountLast4 ?? null,
    currency: input.summary.currency,
    balanceBreaks: input.summary.balanceBreaks,
    gap: input.summary.gap,
    complete: input.summary.complete,
    encryptedBytes: null,
    bytesStored: false,
    replayJson: replay,
  };
  const source = input.source && input.source !== "review" ? input.source : undefined;
  const origin = {
    ...(input.messageId ? { messageId: input.messageId.slice(0, 200) } : {}),
    ...(input.sender ? { sender: input.sender.slice(0, 200) } : {}),
    ...(input.subject ? { subject: input.subject.slice(0, 200) } : {}),
    ...(source ? { source } : {}),
  };
  await db.statementFile.upsert({
    where: { userId_contentHash: { userId, contentHash: input.contentHash } },
    create: { userId, contentHash: input.contentHash, source: source ?? "upload", messageId: input.messageId?.slice(0, 200) ?? null, sender: input.sender?.slice(0, 200) ?? null, subject: input.subject?.slice(0, 200) ?? null, ...data },
    update: { ...data, ...origin },
  });
  return status;
}

/** Keep an unreadable or locked statement visible in Review / Sync history. Bytes are sealed, and only while a password is required. */
export async function queueStatementFile(userId: string, input: {
  bytes?: Buffer;
  fileName: string;
  contentHash: string;
  institution?: string;
  source: string;
  messageId?: string;
  sender?: string;
  subject?: string;
  status: "needs_password" | "unrecognised";
  detail: string;
}): Promise<void> {
  const existing = await db.statementFile.findUnique({ where: { userId_contentHash: { userId, contentHash: input.contentHash } } });
  if (existing && (existing.status === "imported" || existing.status === "duplicate")) {
    await markStatementDuplicate(existing.id, input);
    return;
  }
  if (existing?.status === input.status) {
    await db.statementFile.update({
      where: { id: existing.id },
      data: { occurrences: { increment: 1 }, detail: input.detail.slice(0, 300) },
    });
    return;
  }
  let encryptedBytes: string | null = null;
  let detail = input.detail.slice(0, 300);
  if (input.status === "needs_password" && input.bytes) {
    try {
      encryptedBytes = sealBytes(input.bytes);
    } catch {
      detail = "This statement needs a password, but it could not be saved on this machine. Set STATEMENT_PASSWORD_KEY or ENCRYPTION_KEY and send it again.";
    }
  }
  await db.statementFile.upsert({
    where: { userId_contentHash: { userId, contentHash: input.contentHash } },
    create: {
      userId,
      contentHash: input.contentHash,
      fileName: input.fileName.slice(0, 160),
      institution: input.institution?.slice(0, 80) ?? null,
      source: input.source,
      messageId: input.messageId?.slice(0, 200) ?? null,
      sender: input.sender?.slice(0, 200) ?? null,
      subject: input.subject?.slice(0, 200) ?? null,
      status: input.status,
      detail,
      encryptedBytes,
      bytesStored: !!encryptedBytes,
    },
    update: {
      fileName: input.fileName.slice(0, 160),
      institution: input.institution?.slice(0, 80) ?? null,
      source: input.source,
      status: input.status,
      detail,
      encryptedBytes,
      bytesStored: !!encryptedBytes,
      messageId: input.messageId?.slice(0, 200) ?? null,
      sender: input.sender?.slice(0, 200) ?? null,
      subject: input.subject?.slice(0, 200) ?? null,
    },
  });
  const conn = await statementConnection(userId);
  await db.syncRun.create({
    data: {
      userId,
      connectionId: conn.id,
      status: input.status,
      finishedAt: new Date(),
      label: `${input.fileName} · ${input.institution ?? "Statement"}`.slice(0, 160),
      error: detail,
    },
  });
}

export async function readQueuedStatement(userId: string, id: string): Promise<{ id: string; institution: string | null; bytes: Buffer; fileName: string } | null> {
  const row = await db.statementFile.findFirst({ where: { id, userId, status: "needs_password" } });
  if (!row?.encryptedBytes) return null;
  return { id: row.id, institution: row.institution, fileName: row.fileName, bytes: openBytes(row.encryptedBytes) };
}
