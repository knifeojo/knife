import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { ingestTransaction, loadOwners, loadUserRules } from "../ledger";
import type { CanonicalTransaction, SourceType } from "../types";
import { scanBalanceGaps } from "./balance";
import { linkAdjacentFee } from "./fees";
import { alertSourceId, parseAlert } from "./registry";
import { storeAlertSample } from "./samples";
import { applyLoanStatus } from "./loan-status";
import { isIngestibleSmsSender } from "./senders";
import type { AlertMessage, ParsedAlert } from "./types";

export type AlertIngestResult =
  | { status: "created" | "duplicate"; transactionId: string; parser: string }
  | { status: "review"; id: string; parser: string }
  | { status: "unparsed"; id: string }
  | { status: "loan_update"; applied: boolean; loanId?: string }
  | { status: "skipped" }
  | { status: "failed"; parser?: string };

async function markProcessed(
  userId: string,
  msg: AlertMessage,
  sourceId: string,
  data: { status: string; parser?: string | null; transactionId?: string | null },
) {
  await db.processedAlert.upsert({
    where: { userId_channel_sourceId: { userId, channel: msg.channel, sourceId } },
    update: data,
    create: {
      userId,
      channel: msg.channel,
      sourceId,
      sender: msg.sender.slice(0, 200),
      subject: (msg.subject ?? "").slice(0, 200) || null,
      receivedAt: msg.receivedAt,
      ...data,
    },
  });
}

async function queueUnparsed(
  userId: string,
  msg: AlertMessage,
  reason: "unparsed" | "low_confidence" | "known_sender" | "loan_update",
  parser?: string,
): Promise<string> {
  storeAlertSample({ userId, channel: msg.channel, sender: msg.sender, parser, body: msg.body });
  const row = await db.unparsedAlert.create({
    data: {
      userId,
      channel: msg.channel,
      sender: msg.sender.slice(0, 200),
      receivedAt: msg.receivedAt,
      rawText: msg.body.slice(0, 4000),
      reason,
      parser,
    },
  });
  return row.id;
}

async function postAlert(userId: string, parsed: ParsedAlert, source: SourceType, sourceTransactionId: string) {
  const rules = await loadUserRules(userId);
  const owners = await loadOwners(userId);
  const canonical: CanonicalTransaction = { ...parsed, source, sourceTransactionId };
  const result = await ingestTransaction(userId, canonical, rules, owners);
  const posted = await db.transaction.findUnique({ where: { id: result.transactionId } });
  if (posted) {
    await linkAdjacentFee(userId, posted.id);
    await scanBalanceGaps(userId, posted.accountId);
  }
  return result;
}

/** Parse one alert and either post it, queue it for Review, or skip it. Idempotent on (user, channel, sourceId). */
export async function ingestAlertMessage(
  userId: string,
  msg: AlertMessage,
  opts: { source: SourceType; sourceId?: string } = { source: msg.channel === "push" ? "push" : msg.channel === "sms" ? "sms" : "inbound" },
): Promise<AlertIngestResult> {
  const parseAs = msg.channel === "push" ? { ...msg, channel: "sms" as const } : msg;
  if (parseAs.channel === "sms" && !isIngestibleSmsSender(parseAs.sender)) return { status: "skipped" };

  const sourceId = alertSourceId(msg, opts.sourceId);
  const seen = await db.processedAlert.findUnique({
    where: { userId_channel_sourceId: { userId, channel: msg.channel, sourceId } },
  });
  if (seen) {
    if (seen.transactionId) return { status: "duplicate", transactionId: seen.transactionId, parser: seen.parser ?? "" };
    if (seen.status === "loan_update") return { status: "loan_update", applied: true };
    if (seen.status === "review" || seen.status === "unparsed") return { status: seen.status as "review" | "unparsed", id: seen.id, parser: seen.parser ?? "" };
    return { status: "skipped" };
  }

  const loan = await applyLoanStatus(userId, parseAs, sourceId);
  if (loan?.status === "loan_update") {
    await markProcessed(userId, msg, sourceId, { status: "loan_update", parser: "LoanStatus" });
    return loan;
  }
  if (loan?.status === "review") {
    if (loan.recorded) return { status: "review", id: "", parser: "LoanStatus" };
    const id = await queueUnparsed(userId, msg, "loan_update", "LoanStatus");
    await markProcessed(userId, msg, sourceId, { status: "review", parser: "LoanStatus" });
    return { status: "review", id, parser: "LoanStatus" };
  }

  const outcome = parseAlert(parseAs);
  if (outcome.status === "skipped") {
    await markProcessed(userId, msg, sourceId, { status: "skipped" });
    return { status: "skipped" };
  }
  if (outcome.status === "failed") {
    const id = await queueUnparsed(userId, msg, "unparsed", outcome.parser);
    await markProcessed(userId, msg, sourceId, { status: "failed", parser: outcome.parser });
    return { status: "failed", parser: outcome.parser, ...(id ? {} : {}) };
  }
  if (outcome.status === "unparsed") {
    const id = await queueUnparsed(userId, msg, "known_sender");
    await markProcessed(userId, msg, sourceId, { status: "unparsed" });
    return { status: "unparsed", id };
  }

  if (outcome.status === "review") {
    const id = await queueUnparsed(userId, msg, "low_confidence", outcome.parser);
    await markProcessed(userId, msg, sourceId, { status: "review", parser: outcome.parser });
    return { status: "review", id, parser: outcome.parser };
  }

  const posted = await postAlert(userId, outcome.transaction, opts.source, sourceId);
  await markProcessed(userId, msg, sourceId, {
    status: posted.status === "created" ? "parsed" : "duplicate",
    parser: outcome.parser,
    transactionId: posted.transactionId,
  });
  return { status: posted.status, transactionId: posted.transactionId, parser: outcome.parser };
}

export async function ingestSmsPayload(
  userId: string,
  body: { sender: string; body: string; receivedAt?: string; sourceId?: string },
): Promise<AlertIngestResult> {
  const receivedAt = body.receivedAt ? new Date(body.receivedAt) : new Date();
  if (Number.isNaN(receivedAt.getTime())) throw new Error("receivedAt is not a date");
  return ingestAlertMessage(
    userId,
    { channel: "sms", sender: String(body.sender).slice(0, 80), body: String(body.body).slice(0, 4000), receivedAt },
    { source: "sms", sourceId: body.sourceId },
  );
}

export async function ingestPushPayload(
  userId: string,
  body: { sender: string; body: string; receivedAt?: string; sourceId?: string },
): Promise<AlertIngestResult> {
  const receivedAt = body.receivedAt ? new Date(body.receivedAt) : new Date();
  if (Number.isNaN(receivedAt.getTime())) throw new Error("receivedAt is not a date");
  return ingestAlertMessage(
    userId,
    { channel: "push", sender: String(body.sender).slice(0, 80), body: String(body.body).slice(0, 4000), receivedAt },
    { source: "push", sourceId: body.sourceId },
  );
}

export function smsIdempotencyKey(sender: string, body: string, receivedAt: Date): string {
  return createHash("sha256").update(`sms|${sender}|${body}|${receivedAt.toISOString()}`).digest("hex");
}

export async function resolveUnparsed(
  userId: string,
  id: string,
  action: "ignore" | "add",
): Promise<{ ok: true } | { error: string }> {
  const row = await db.unparsedAlert.findFirst({ where: { id, userId, status: "open" } });
  if (!row) return { error: "Alert not found" };
  if (action === "ignore") {
    await db.unparsedAlert.update({ where: { id }, data: { status: "ignored", resolvedAt: new Date() } });
    return { ok: true };
  }
  const msg: AlertMessage = { channel: row.channel as "email" | "sms", sender: row.sender, body: row.rawText, receivedAt: row.receivedAt };
  const outcome = parseAlert(msg);
  if (outcome.status !== "parsed" && outcome.status !== "review") return { error: "Still cannot parse this alert." };
  const posted = await postAlert(userId, outcome.transaction, row.channel === "sms" ? "sms" : "inbound", `unparsed:${id}`);
  await db.unparsedAlert.update({ where: { id }, data: { status: "added", resolvedAt: new Date() } });
  return posted ? { ok: true } : { error: "Could not add this alert." };
}
