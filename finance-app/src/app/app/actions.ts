"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { decrypt } from "@/lib/crypto";
import { log } from "@/lib/log";
import { ALL_CATEGORIES } from "@/core/categorize";
import { NotFoundError, monthPeriod, recategorize } from "@/core/analytics";
import { reapplyCategories, reapplyMessage, syncEmailSource } from "@/core/ledger";
import { finishTopPeople, isRelationshipStatus, saveOnboarding, splitNames } from "@/core/onboarding";
import { QUESTION_KINDS, answerQuestion, askAgain, type QuestionKind } from "@/core/review";
import { PeopleInputError, PersonNotFoundError, addPeopleFromText, createPerson, deletePerson, mergePeople, undoPeopleBatch, updatePerson, type PersonPatch } from "@/core/people";
import { isRelationship } from "@/core/people-match";
import { AI_FEATURES, aiAllowed, configFor, parseRoute, routingFor, setUserPrefs, type AiPrefs } from "@/core/ai/client";
import { aiClassifier, llmFor, suggestCategories, suggestInBackground } from "@/core/ai/categorizer";
import { SuggestionNotFoundError, confirmSuggestion, dismissSuggestion } from "@/core/ai/suggestions";
import type { AssistantTurn, ToolCallLog } from "@/core/ai/assistant";
import { chatForUser, phraseForUser } from "@/core/ai/router";
import { redactorFor } from "@/core/ai/redact";
import { rulesClassifier, scoreUser } from "@/core/eval";
import { FixtureEmailSource } from "@/core/providers/fixture";
import { GmailEmailSource, revokeToken } from "@/core/providers/gmail";
import { ask } from "@/core/ask/answer";
import type { Facts } from "@/core/ask/answer";
import { applyNoteLabel, matchNotes, monthFromHeading, parseNotes, type NoteMatch } from "@/core/notes";
import { specificMonth } from "@/core/analytics";
import { affordabilityJson, checkAffordability, cleanDescription, parseAmountInput, parseHorizon, type AffordabilityJson } from "@/core/affordability";
import { MAX_STATEMENT_FILES, StatementFormatError, importStatement, recordFailedImport, resolveIssueByAdding, resolveIssueByIgnoring, type StatementImportSummary } from "@/core/statement-import";
import { FX_CURRENCIES, clearManualRate, importMarketRates, setManualRate } from "@/core/fx/provider";

export type SyncState = { ok?: string; error?: string } | undefined;

export async function syncNow(_: SyncState, form: FormData): Promise<SyncState> {
  const user = await requireUser();
  const provider = String(form.get("provider"));
  const conn = await db.financialConnection.findFirst({ where: { userId: user.id, provider, status: { not: "revoked" } } });
  if (!conn) return { error: "Connection not found" };
  try {
    const source =
      provider === "gmail" ? new GmailEmailSource(conn.id)
      : provider === "imap" ? (await import("@/core/alerts/imap")).ImapEmailSource.fromConnection(conn)
      : new FixtureEmailSource();
    const r = await syncEmailSource(user.id, conn.id, source);
    revalidatePath("/app", "layout");
    return {
      ok: r.emailsScanned === 0
        ? "Up to date. No new alerts since the last sync."
        : `Scanned ${r.emailsScanned} emails: ${r.created} new transactions, ${r.duplicates} duplicates merged, ${r.parseFailures} could not be parsed.`,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Sync failed" };
  }
}

/** Dev/testing path: runs the bundled synthetic GTBank alerts through the real pipeline. */
export async function importSampleAlerts(): Promise<SyncState> {
  const user = await requireUser();
  const conn = await db.financialConnection.upsert({
    where: { userId_provider: { userId: user.id, provider: "fixture" } },
    update: { status: "active" },
    create: { userId: user.id, provider: "fixture", providerAccountId: "Sample GTBank alerts", lastSyncedAt: new Date("2026-01-01") },
  });
  // Always rescan the whole sample inbox so re-imports demonstrate dedup
  await db.processedEmail.deleteMany({ where: { userId: user.id, connectionId: conn.id } });
  await db.financialConnection.update({ where: { id: conn.id }, data: { lastSyncedAt: new Date("2026-01-01") } });
  const r = await syncEmailSource(user.id, conn.id, new FixtureEmailSource());
  revalidatePath("/app", "layout");
  return {
    ok: `Scanned ${r.emailsScanned} sample emails: ${r.created} new, ${r.duplicates} duplicates merged, ${r.parseFailures} parse failures, ${r.skipped} not bank alerts.`,
  };
}

export async function saveImapConnection(form: FormData) {
  const user = await requireUser();
  if (user.isDemo) redirect("/app/accounts?imap=demo");
  const host = String(form.get("imapHost") ?? "").trim().slice(0, 200);
  const port = Number(form.get("imapPort") ?? 993);
  const imapUser = String(form.get("imapUser") ?? "").trim().slice(0, 200);
  if (!host || !imapUser || !Number.isInteger(port) || port < 1 || port > 65535) redirect("/app/accounts?imap=error");
  await db.financialConnection.upsert({
    where: { userId_provider: { userId: user.id, provider: "imap" } },
    update: { imapHost: host, imapPort: port, imapUser, providerAccountId: imapUser, status: "active", lastError: null },
    create: { userId: user.id, provider: "imap", imapHost: host, imapPort: port, imapUser, providerAccountId: imapUser, status: "active" },
  });
  revalidatePath("/app", "layout");
  redirect("/app/accounts?imap=saved");
}

export async function importPastAlerts(_: SyncState, form: FormData): Promise<SyncState> {
  const user = await requireUser();
  const provider = String(form.get("provider") || "gmail");
  const conn = await db.financialConnection.findFirst({ where: { userId: user.id, provider, status: { not: "revoked" } } });
  if (!conn) return { error: "Connect Gmail or IMAP first." };
  await db.financialConnection.update({ where: { id: conn.id }, data: { lastSyncedAt: null, gmailHistoryId: null } });
  try {
    const { syncOneConnection } = await import("@/core/alerts/scheduler");
    if (provider === "gmail" || provider === "imap") await syncOneConnection(conn.id);
    else {
      const { FixtureEmailSource } = await import("@/core/providers/fixture");
      await syncEmailSource(user.id, conn.id, new FixtureEmailSource());
    }
    revalidatePath("/app", "layout");
    return { ok: "Imported past alerts." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Import failed" };
  }
}

export async function importMboxAction(form: FormData) {
  const user = await requireUser();
  const file = form.get("mbox");
  if (!(file instanceof File) || !file.size) redirect("/app/accounts?mbox=empty");
  if (file.size > 20_000_000) redirect("/app/accounts?mbox=large");
  const { parseMbox } = await import("@/core/alerts/mbox");
  const { ingestAlertMessage } = await import("@/core/alerts/ingest");
  const { emailToAlert } = await import("@/core/alerts/email-adapter");
  const emails = parseMbox(await file.text());
  let created = 0;
  let review = 0;
  for (const email of emails) {
    const r = await ingestAlertMessage(user.id, emailToAlert(email), { source: "inbound", sourceId: email.id });
    if (r.status === "created") created++;
    if (r.status === "review" || r.status === "unparsed") review++;
  }
  revalidatePath("/app", "layout");
  redirect(`/app/accounts?mbox=ok&found=${created}&review=${review}&scanned=${emails.length}`);
}

export async function dismissForwardingNotice(form: FormData) {
  const user = await requireUser();
  await db.forwardingNotice.updateMany({ where: { id: String(form.get("id")), userId: user.id }, data: { status: "dismissed" } });
  revalidatePath("/app", "layout");
}

export async function resolveUnparsedAction(form: FormData) {
  const user = await requireUser();
  const { resolveUnparsed } = await import("@/core/alerts/ingest");
  await resolveUnparsed(user.id, String(form.get("id")), form.get("action") === "add" ? "add" : "ignore");
  revalidatePath("/app", "layout");
}

export async function dismissGapAction(form: FormData) {
  const user = await requireUser();
  await db.balanceGap.updateMany({ where: { id: String(form.get("id")), userId: user.id }, data: { status: "dismissed" } });
  revalidatePath("/app", "layout");
}

export async function dismissReconAction(form: FormData) {
  const user = await requireUser();
  await db.reconFlag.updateMany({ where: { id: String(form.get("id")), userId: user.id }, data: { status: "dismissed" } });
  revalidatePath("/app", "layout");
}

export async function disconnectGmail() {
  const user = await requireUser();
  const conn = await db.financialConnection.findFirst({ where: { userId: user.id, provider: "gmail" } });
  if (conn) {
    const token = conn.encryptedRefreshToken ?? conn.encryptedAccessToken;
    if (token) await revokeToken(decrypt(token));
    await db.financialConnection.update({
      where: { id: conn.id },
      data: { status: "revoked", encryptedAccessToken: null, encryptedRefreshToken: null, accessTokenExpiresAt: null },
    });
    log.info("gmail.disconnected", { userId: user.id });
  }
  revalidatePath("/app/accounts");
}

export async function recategorizeAction(form: FormData) {
  const user = await requireUser();
  const id = String(form.get("id"));
  const category = String(form.get("category"));
  if (!ALL_CATEGORIES.includes(category)) return;
  try {
    await recategorize(user.id, id, category, null, true);
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
  revalidatePath("/app", "layout");
}

export type AskState = { question: string; answer: string; answerSource: "llm" | "template"; facts: Facts } | { error: string } | undefined;

export async function askAction(_: AskState, form: FormData): Promise<AskState> {
  const user = await requireUser();
  const question = String(form.get("q") ?? "").trim().slice(0, 300);
  if (!question) return { error: "Type a question first." };
  const { facts } = await ask(user.id, question);
  const phrased = await phraseForUser(user.id, question, facts);
  return { question, answer: phrased.text, answerSource: phrased.source, facts };
}

export async function deleteMyData() {
  const user = await requireUser();
  await db.$transaction([
    db.transaction.deleteMany({ where: { userId: user.id } }),
    db.transactionSource.deleteMany({ where: { userId: user.id } }),
    db.account.deleteMany({ where: { userId: user.id } }),
    db.processedEmail.deleteMany({ where: { userId: user.id } }),
    db.processedAlert.deleteMany({ where: { userId: user.id } }),
    db.unparsedAlert.deleteMany({ where: { userId: user.id } }),
    db.balanceGap.deleteMany({ where: { userId: user.id } }),
    db.reconFlag.deleteMany({ where: { userId: user.id } }),
    db.forwardingNotice.deleteMany({ where: { userId: user.id } }),
    db.merchantAlias.deleteMany({ where: { userId: user.id } }),
    db.syncRun.deleteMany({ where: { userId: user.id } }),
    db.loan.deleteMany({ where: { userId: user.id } }),
    db.financialConnection.updateMany({ where: { userId: user.id }, data: { lastSyncedAt: null, gmailHistoryId: null, lastProcessedMessageId: null } }),
  ]);
  revalidatePath("/app", "layout");
  redirect("/app");
}

export type StatementFileResult = { file: string } & ({ ok: StatementImportSummary } | { error: string });
export type StatementState = { results: StatementFileResult[] } | { error: string } | undefined;

/** Accepts several statements at once, from any mix of banks. Files are parsed in memory and not stored. */
export async function importStatementsAction(_: StatementState, form: FormData): Promise<StatementState> {
  const user = await requireUser();
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return { error: "Choose at least one statement file." };
  if (files.length > MAX_STATEMENT_FILES) return { error: `Upload up to ${MAX_STATEMENT_FILES} files at a time.` };
  const fallbackBank = String(form.get("institution") || "") || undefined;
  const password = String(form.get("pdfPassword") || "") || undefined;

  const results: StatementFileResult[] = [];
  // Sequential on purpose: overlapping statements dedupe against each other in order.
  for (const f of files) {
    try {
      const summary = await importStatement(user.id, { name: f.name, bytes: Buffer.from(await f.arrayBuffer()) }, { institution: fallbackBank, password });
      results.push({ file: f.name, ok: summary });
    } catch (e) {
      const message = e instanceof StatementFormatError ? e.message : "Could not read this file.";
      if (!(e instanceof StatementFormatError)) log.error("statement.failed", { userId: user.id, error: e instanceof Error ? e.message : "unknown" });
      results.push({ file: f.name, error: message });
      await recordFailedImport(user.id, f.name, message);
    }
  }
  if (results.some((r) => "ok" in r)) suggestInBackground(user.id);
  revalidatePath("/app", "layout");
  return { results };
}

export async function reapplyCategoriesAction(): Promise<SyncState> {
  const user = await requireUser();
  const r = await reapplyCategories(user.id);
  revalidatePath("/app", "layout");
  return { ok: reapplyMessage(r) };
}

export async function answerQuestionAction(form: FormData) {
  const user = await requireUser();
  const kind = String(form.get("kind")) as QuestionKind;
  if (!QUESTION_KINDS.includes(kind)) return;
  const value = String(form.get("value"));
  const text = String(form.get("otherText") ?? "").slice(0, 60);
  if (value === "other" && !text.trim()) return;
  const vendorCategory = String(form.get("vendorCategory") ?? "");
  const vendor = value === "rel:vendor" && ALL_CATEGORIES.includes(vendorCategory)
    ? { text: "", category: vendorCategory, subcategory: String(form.get("vendorSubcategory") ?? "").slice(0, 40) || undefined }
    : undefined;
  await answerQuestion(user.id, kind, String(form.get("key")).slice(0, 120), value, value === "other" ? { text, category: String(form.get("otherCategory") ?? "") || undefined } : vendor);
  revalidatePath("/app", "layout");
}

export async function saveOnboardingAction(form: FormData) {
  const user = await requireUser();
  const status = String(form.get("relationshipStatus") ?? "");
  await saveOnboarding(user.id, {
    skip: String(form.get("skip") ?? "") === "1",
    ownName: String(form.get("ownName") ?? "").slice(0, 80),
    relationshipStatus: isRelationshipStatus(status) ? status : undefined,
    partners: splitNames(String(form.get("partner") ?? "")),
    parents: splitNames(String(form.get("parents") ?? "")),
    siblings: splitNames(String(form.get("siblings") ?? "")),
    supported: splitNames(String(form.get("supported") ?? "")),
  });
  revalidatePath("/app", "layout");
  redirect("/app");
}

export async function finishTopPeopleAction() {
  const user = await requireUser();
  await finishTopPeople(user.id);
  revalidatePath("/app", "layout");
}

// ---- Your people ----

const field = (form: FormData, name: string, max = 80) => String(form.get(name) ?? "").trim().slice(0, max);
const peopleDone = () => revalidatePath("/app", "layout");

/** "My wife is Gift Adebayo Ojo" lines. Lines Ledger could not read come back in the URL to fix. */
export async function addPeopleTextAction(form: FormData) {
  const user = await requireUser();
  const text = String(form.get("text") ?? "").slice(0, 2000);
  if (!text.trim()) return;
  const res = await addPeopleFromText(user.id, text);
  peopleDone();
  const q = new URLSearchParams({ added: String(res.added.length), updated: String(res.added.reduce((t, a) => t + a.changed, 0)) });
  if (res.unread.length) q.set("unread", res.unread.join("\n").slice(0, 500));
  redirect(`/app/people?${q}`);
}

export async function addPersonAction(form: FormData) {
  const user = await requireUser();
  const relationship = field(form, "relationship", 20);
  const displayName = field(form, "displayName");
  if (!displayName || !isRelationship(relationship)) return;
  const vendorCategory = field(form, "vendorCategory", 40);
  await createPerson(user.id, {
    displayName, relationship, note: field(form, "note", 120) || null,
    ...(relationship === "vendor" && ALL_CATEGORIES.includes(vendorCategory) && { vendorCategory, vendorSubcategory: field(form, "vendorSubcategory", 40) || null }),
  });
  peopleDone();
}

export async function updatePersonAction(form: FormData) {
  const user = await requireUser();
  const id = field(form, "id", 40);
  const patch: PersonPatch = {};
  const relationship = field(form, "relationship", 20);
  if (isRelationship(relationship)) patch.relationship = relationship;
  if (form.has("note")) patch.note = field(form, "note", 120) || null;
  if (form.has("vendorCategory")) {
    const c = field(form, "vendorCategory", 40);
    patch.vendorCategory = ALL_CATEGORIES.includes(c) ? c : null;
    patch.vendorSubcategory = field(form, "vendorSubcategory", 40) || null;
  }
  const alias = field(form, "alias");
  const aliasOp = field(form, "aliasOp", 10);
  if (alias && aliasOp === "add") patch.addAliases = [alias];
  if (alias && aliasOp === "reject") patch.rejectAliases = [alias];
  if (alias && aliasOp === "remove") patch.removeAliases = [alias];
  if (!Object.keys(patch).length) return;
  try {
    await updatePerson(user.id, id, patch);
  } catch (e) {
    if (!(e instanceof PersonNotFoundError || e instanceof PeopleInputError)) throw e;
  }
  peopleDone();
}

export async function mergePeopleAction(form: FormData) {
  const user = await requireUser();
  try {
    await mergePeople(user.id, field(form, "targetId", 40), field(form, "sourceId", 40));
  } catch (e) {
    if (!(e instanceof PersonNotFoundError || e instanceof PeopleInputError)) throw e;
  }
  peopleDone();
}

export async function deletePersonAction(form: FormData) {
  const user = await requireUser();
  try {
    await deletePerson(user.id, field(form, "id", 40));
  } catch (e) {
    if (!(e instanceof PersonNotFoundError)) throw e;
  }
  peopleDone();
}

export async function undoPeopleAction(form: FormData) {
  const user = await requireUser();
  try {
    await undoPeopleBatch(user.id, field(form, "batchId", 40) || undefined);
  } catch (e) {
    if (!(e instanceof PersonNotFoundError || e instanceof PeopleInputError)) throw e;
  }
  peopleDone();
}

export async function askAgainAction(form: FormData) {
  const user = await requireUser();
  await askAgain(user.id, String(form.get("pattern")).slice(0, 120));
  revalidatePath("/app", "layout");
}

const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

export async function setAiConsentAction(form: FormData) {
  const user = await requireUser();
  if (user.isDemo) return;
  await db.user.update({ where: { id: user.id }, data: { aiConsent: form.get("on") === "1" } });
  revalidatePath("/app", "layout");
}

/** Settings: Local / Cloud / Off (or "default") for each AI feature. */
export async function setAiRoutesAction(form: FormData) {
  const user = await requireUser();
  if (user.isDemo) return;
  const prefs: AiPrefs = {};
  for (const f of AI_FEATURES) {
    const v = form.get(f);
    if (v === null) continue;
    prefs[f] = v === "default" ? null : (parseRoute(v) ?? null);
  }
  await setUserPrefs(user.id, prefs);
  revalidatePath("/app", "layout");
}

export async function runAiCategorizeAction(): Promise<SyncState> {
  const user = await requireUser();
  const routing = await routingFor(user.id);
  const cat = routing.features.categorize;
  if (routing.problem || cat.route === "off") return { error: routing.problem ?? cat.note ?? "AI categorization is off." };
  if (!(await aiAllowed(user.id))) return { error: "Turn on AI in Settings first." };
  const r = await suggestCategories(user.id, { limit: 40, routing });
  revalidatePath("/app", "layout");
  if (r.stopped && !r.asked) return { error: r.stopped };
  const more = r.remaining ? ` ${r.remaining} still to look at: run again, or use npm run ai:suggest for the whole backlog.` : "";
  const stop = r.stopped ? ` Stopped early: ${r.stopped}` : "";
  const split = r.cloud.rows ? ` Local model: ${r.local.rows} rows; cloud model: ${r.cloud.rows} rows${r.escalated ? ` (${r.escalated} second opinions)` : ""}.` : "";
  const escStop = r.escalationStopped ? ` Second opinions stopped: ${r.escalationStopped}` : "";
  return { ok: r.asked ? `AI looked at ${r.asked} uncertain transactions and has ${r.suggested} suggestions waiting in Review. Nothing changes until you confirm.${split}${more}${stop}${escStop}` : "Nothing uncertain left for the AI to look at." };
}

export async function confirmSuggestionAction(form: FormData) {
  const user = await requireUser();
  try {
    await confirmSuggestion(user.id, String(form.get("id")).slice(0, 40));
  } catch (e) {
    if (!(e instanceof SuggestionNotFoundError)) throw e;
  }
  revalidatePath("/app", "layout");
}

export async function dismissSuggestionAction(form: FormData) {
  const user = await requireUser();
  try {
    await dismissSuggestion(user.id, String(form.get("id")).slice(0, 40));
  } catch (e) {
    if (!(e instanceof SuggestionNotFoundError)) throw e;
  }
  revalidatePath("/app", "layout");
}

export async function measureAccuracyAction(): Promise<SyncState> {
  const user = await requireUser();
  const rules = await scoreUser(user.id, rulesClassifier, "rules");
  let msg = `Rules alone: ${(rules.accuracy * 100).toFixed(0)}% of your ${rules.labelled} answered transactions (${(rules.valueAccuracy * 100).toFixed(0)}% by value).`;
  const routing = await routingFor(user.id);
  const config = configFor(routing, routing.features.categorize.route);
  if (config.provider !== "off" && (await aiAllowed(user.id))) {
    const llm = llmFor(config, config.provider === "anthropic" ? { redactor: await redactorFor(user.id) } : {});
    const ai = await scoreUser(user.id, aiClassifier(user.id, rulesClassifier, llm), "rules+ai");
    msg += ` Rules + AI: ${(ai.accuracy * 100).toFixed(0)}% (${(ai.valueAccuracy * 100).toFixed(0)}% by value).`;
  }
  revalidatePath("/app/settings");
  return { ok: msg };
}

export type ChatResult =
  | { mode: "ai"; text: string; grounded: boolean; toolCalls: ToolCallLog[]; provider?: "ollama" | "anthropic" }
  | { mode: "rules"; text: string; facts: Facts; phrasedBy?: "ollama" | "anthropic" }
  | { error: string };

/** One chat turn. Uses the AI assistant when allowed, else the deterministic question answering. */
export async function chatAction(question: string, history: AssistantTurn[]): Promise<ChatResult> {
  const user = await requireUser();
  const q = question.trim().slice(0, 400);
  if (!q) return { error: "Type a question first." };
  const reply = await chatForUser(user.id, q, history.slice(-6).map((t) => ({ role: t.role, text: String(t.text).slice(0, 2000) })));
  if (reply) return plain({ mode: "ai" as const, ...reply });
  // If the current month has no data yet (e.g. statement imported on the 1st), answer for the latest month that does.
  const now = new Date();
  const latest = await db.transaction.findFirst({ where: { userId: user.id }, orderBy: { transactionDate: "desc" }, select: { transactionDate: true } });
  const current = monthPeriod(now, 0);
  const stale = latest && latest.transactionDate < current.from && !/last month|previous month|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|year|days|months/i.test(q);
  const asOf = stale ? latest!.transactionDate : now;
  const { facts } = await ask(user.id, q, asOf);
  const note = stale ? `No transactions imported for ${current.label} yet, so here is ${monthPeriod(asOf, 0).label}. ` : "";
  const phrased = await phraseForUser(user.id, q, facts);
  return plain({ mode: "rules" as const, text: note + phrased.text, facts, phrasedBy: phrased.provider });
}

export async function dismissImportResultsAction() {
  const user = await requireUser();
  await db.syncRun.updateMany({ where: { userId: user.id, seenAt: null }, data: { seenAt: new Date() } });
  revalidatePath("/app", "layout");
}

export type IssueState = { ok?: string; error?: string } | undefined;

export async function addIssueAction(_: IssueState, form: FormData): Promise<IssueState> {
  const user = await requireUser();
  try {
    await resolveIssueByAdding(user.id, String(form.get("issueId")), {
      date: String(form.get("date") ?? ""),
      direction: form.get("direction") === "in" ? "in" : "out",
      amount: String(form.get("amount") ?? ""),
      description: String(form.get("description") ?? ""),
    });
  } catch (e) {
    return { error: e instanceof StatementFormatError ? e.message : "Could not add this transaction." };
  }
  revalidatePath("/app", "layout");
  return { ok: "Added to your ledger." };
}

export async function ignoreIssueAction(form: FormData) {
  const user = await requireUser();
  await resolveIssueByIgnoring(user.id, String(form.get("issueId")));
  revalidatePath("/app", "layout");
}

export type NotesState = { month?: string; results?: NoteMatch[]; applied?: number; error?: string } | undefined;

/** Reads the user's rough notes against a month of their ledger. Nothing is changed here. */
export async function matchNotesAction(_: NotesState, form: FormData): Promise<NotesState> {
  const user = await requireUser();
  const text = String(form.get("notes") ?? "").slice(0, 10_000);
  const lines = parseNotes(text);
  if (!lines.length) return { error: "Paste a few lines from your notes, like \"Wife 750\" or \"Rent 500k\"." };
  const picked = String(form.get("month") ?? "").match(/^(\d{4})-(\d{2})$/);
  const period = picked ? specificMonth(Number(picked[1]), Number(picked[2]) - 1) : monthFromHeading(text, new Date().getFullYear());
  if (!period) return { error: "Which month are these notes for? Pick it above, or start your notes with a heading like \"Expense Sept\"." };
  return plain({ month: period.label, results: await matchNotes(user.id, period, lines) });
}

/** Labels the transactions the user ticked with the purpose from their notes. Their own labels are kept. */
export async function applyNotesAction(form: FormData) {
  const user = await requireUser();
  let applied = 0;
  for (const raw of form.getAll("apply")) {
    const item = JSON.parse(String(raw)) as { ids: string[]; category: string; subcategory: string };
    if (!ALL_CATEGORIES.includes(item.category as (typeof ALL_CATEGORIES)[number]) || !Array.isArray(item.ids)) continue;
    applied += await applyNoteLabel(user.id, item.ids.slice(0, 50).map(String), { category: item.category, subcategory: String(item.subcategory) });
  }
  revalidatePath("/app", "layout");
  return applied;
}

export type AffordState = { result: AffordabilityJson } | { error: string } | undefined;

/** "Can I really afford this?" Read-only: nothing in the ledger changes. */
export async function affordAction(_: AffordState, form: FormData): Promise<AffordState> {
  const user = await requireUser();
  const amountMinor = parseAmountInput(String(form.get("amount") ?? "").slice(0, 40));
  if (amountMinor === null) return { error: "Enter an amount, like 250,000 or 2.5m." };
  const horizon = parseHorizon(String(form.get("horizon") ?? "month_end")) ?? { kind: "month_end" as const };
  const bufferRaw = String(form.get("buffer") ?? "").trim().slice(0, 40);
  const bufferMinor = bufferRaw ? (/^[₦n]?\s*0+$/i.test(bufferRaw) ? 0n : parseAmountInput(bufferRaw)) : undefined;
  if (bufferMinor === null) return { error: "Enter the buffer as an amount, like 200,000, or leave it empty." };
  if ((await db.transaction.count({ where: { userId: user.id } })) === 0) {
    return { error: "Import a statement first so Ledger has your income and spending to go on." };
  }
  const result = await checkAffordability(user.id, { amountMinor, description: cleanDescription(form.get("description")), horizon, bufferMinor });
  return { result: affordabilityJson(result) };
}

export async function setFxPreferenceAction(form: FormData) {
  const user = await requireUser();
  if (user.isDemo) return;
  const preference = String(form.get("preference"));
  if (preference !== "official" && preference !== "street") return;
  await db.user.update({ where: { id: user.id }, data: { fxNgnPreference: preference } });
  revalidatePath("/app", "layout");
}

export async function setManualRateAction(form: FormData) {
  const user = await requireUser();
  if (user.isDemo) return;
  const base = String(form.get("base"));
  if (!(FX_CURRENCIES as readonly string[]).includes(base)) return;
  const rate = Number(form.get("rate"));
  await setManualRate(user.id, base, "NGN", rate);
  revalidatePath("/app", "layout");
}

export async function clearManualRateAction(form: FormData) {
  const user = await requireUser();
  if (user.isDemo) return;
  const base = String(form.get("base"));
  if (!(FX_CURRENCIES as readonly string[]).includes(base)) return;
  await clearManualRate(user.id, base, "NGN");
  revalidatePath("/app", "layout");
}

export async function importMarketRatesAction(_: SyncState, _form: FormData): Promise<SyncState> {
  const user = await requireUser();
  if (user.isDemo) return { error: "Demo accounts cannot change FX settings." };
  try {
    const r = await importMarketRates();
    revalidatePath("/app", "layout");
    return { ok: `Stored ${r.stored} market rates for ${r.date}.` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not fetch daily rates." };
  }
}
