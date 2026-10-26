import { db } from "@/lib/db";
import { OWN_TRANSFER, categorize, type UserRule } from "./categorize";
import { loadKnownPeople, loadOwners, loadUserRules } from "./ledger";
import {
  aliasKey,
  isRelationship,
  labelFor,
  matchPeople,
  nameWords,
  parsePeopleText,
  relationshipInfo,
  type KnownPerson,
  type Label,
  type Relationship,
} from "./people-match";
import { pairOwnTransfers, unpairContradicted } from "./transfers";

// "Your people": who the owner pays and is paid by. Telling Ledger who someone is relabels every
// matching payment, past and future, and each change is recorded as a batch that can be undone.

export class PersonNotFoundError extends Error {}
export class PeopleInputError extends Error {}

interface PersonSnapshot {
  id: string;
  displayName: string;
  relationship: string;
  note: string | null;
  vendorCategory: string | null;
  vendorSubcategory: string | null;
  createdAt: string;
  aliases: { name: string; key: string; rejected: boolean }[];
}

interface RowBefore {
  id: string;
  category: string;
  subcategory: string | null;
  merchantName: string | null;
  classificationSource: string;
  classificationConfidence: number;
  personId: string | null;
}

interface BatchState {
  /** People as they were before the change, restored on undo. */
  restore: PersonSnapshot[];
  /** People the change created, deleted on undo. */
  remove: string[];
  /** Suggestions the change resolved, set back to pending on undo. */
  suggestions: string[];
}

interface RemovedRule {
  pattern: string;
  canonicalName: string;
  category: string | null;
  subcategory: string | null;
}

export interface PersonInput {
  displayName: string;
  relationship: string;
  note?: string | null;
  aliases?: string[];
  vendorCategory?: string | null;
  vendorSubcategory?: string | null;
}

export interface PersonPatch {
  displayName?: string;
  relationship?: string;
  note?: string | null;
  vendorCategory?: string | null;
  vendorSubcategory?: string | null;
  addAliases?: string[];
  /** Spellings that are not this person: never matched to them again. */
  rejectAliases?: string[];
  /** Spellings to forget (neither matched nor rejected). */
  removeAliases?: string[];
}

export interface ApplyResult {
  personId: string;
  batchId: string;
  /** Transactions whose label or person changed. */
  changed: number;
}

const tidyName = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80);
const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

async function snapshot(userId: string, ids: string[]): Promise<PersonSnapshot[]> {
  const rows = await db.person.findMany({ where: { userId, id: { in: ids } }, include: { aliases: true } });
  return rows.map((p) => ({
    id: p.id, displayName: p.displayName, relationship: p.relationship, note: p.note, vendorCategory: p.vendorCategory, vendorSubcategory: p.vendorSubcategory,
    createdAt: p.createdAt.toISOString(), aliases: p.aliases.map((a) => ({ name: a.name, key: a.key, rejected: a.rejected })),
  }));
}

async function addAlias(userId: string, personId: string, name: string, rejected = false): Promise<void> {
  const key = aliasKey(name);
  if (!key) return;
  const clean = tidyName(name);
  await db.personAlias.upsert({
    where: { personId_key: { personId, key } },
    update: { rejected, name: clean },
    create: { userId, personId, name: clean, key, rejected },
  });
}

function validRelationship(r: string): Relationship {
  if (!isRelationship(r)) throw new PeopleInputError(`unknown relationship: ${r}`);
  return r;
}

const sameLabel = (row: { category: string; subcategory: string | null }, l: Label | null | undefined) =>
  !!l && row.category === l.category && (row.subcategory ?? null) === (l.subcategory ?? null);

/**
 * Relabels every transaction of a person after something about them changed (relationship, aliases,
 * a merge) and records a batch with the previous state.
 * - Rows the rules or the AI labelled take the person's label.
 * - Rows the owner labelled stay as they are, unless the label came from this person's previous
 *   relationship, or from an older Review answer about the same name (that rule is retired and kept for undo).
 * - Rows that no longer match (a spelling was removed or rejected) are unlinked and re-categorized.
 */
async function relabel(
  userId: string,
  personId: string,
  opts: { label: string; restore: PersonSnapshot[]; remove: string[]; moved?: Map<string, string> },
): Promise<ApplyResult> {
  const [people, owners] = await Promise.all([loadKnownPeople(userId), loadOwners(userId)]);
  const person = people.find((p) => p.id === personId);
  if (!person) throw new PersonNotFoundError("person not found");
  const linked = new Set([personId]);
  const previous = opts.restore;
  const moved = opts.moved ?? new Map<string, string>();

  // Older Review answers for this name ("mensah abena" -> Friend) would otherwise keep winning.
  const aliasRules = await db.merchantAlias.findMany({ where: { userId, category: { not: null } } });
  const retired = aliasRules.filter((r) => nameWords(r.pattern).length >= 2 && matchPeople(r.pattern, people).personId === personId);
  if (retired.length) await db.merchantAlias.deleteMany({ where: { userId, id: { in: retired.map((r) => r.id) } } });
  const rules: UserRule[] = await loadUserRules(userId);

  const rows = await db.transaction.findMany({
    where: { userId, OR: [{ personId: { in: [...linked] } }, { counterparty: { not: null } }] },
    select: {
      id: true, type: true, description: true, counterparty: true, category: true, subcategory: true, merchantName: true,
      classificationSource: true, classificationConfidence: true, personId: true,
    },
  });

  const changes: RowBefore[] = [];
  const relabelled: string[] = [];
  for (const row of rows) {
    const wasLinked = !!row.personId && linked.has(row.personId);
    const matched = matchPeople(row.counterparty, people).personId === personId;
    // Someone new can make another person's name ambiguous ("Tunde Ojo" once two Tundes are known).
    const other = row.personId && !wasLinked ? people.find((p) => p.id === row.personId) : undefined;
    if (!wasLinked && !matched && !other) continue;
    const type = row.type as "DEBIT" | "CREDIT";
    const c = categorize({ description: row.description, type }, rules, owners);
    if (other && c.personId === other.id) continue;
    const fromPrevious = (wasLinked && previous.some((s) => sameLabel(row, labelFor(s, type)))) || (!!other && sameLabel(row, labelFor(other, type)));
    const fromRetired = row.classificationSource === "user" && retired.some((r) => sameLabel(row, { category: r.category!, subcategory: r.subcategory }));
    const ownLabel = row.classificationSource === "pair" || (row.classificationSource === "user" && !fromPrevious && !fromRetired);

    let next: Omit<RowBefore, "id">;
    if (ownLabel) {
      next = { ...row, personId: c.personId ?? null };
    } else if (c.personId === personId || !matched) {
      next = {
        category: c.category, subcategory: c.subcategory ?? null, merchantName: c.merchantName ?? row.merchantName,
        classificationSource: c.source, classificationConfidence: c.confidence, personId: c.personId ?? null,
      };
    } else {
      // A rule outranks the person for this row (a fee, a loan): keep the rule's label, link the person.
      next = { ...row, personId };
    }
    const changed = (Object.keys(next) as (keyof typeof next)[]).some((k) => k !== "merchantName" && next[k] !== row[k]);
    if (!changed && !moved.has(row.id)) continue;
    changes.push({
      id: row.id, category: row.category, subcategory: row.subcategory, merchantName: row.merchantName,
      classificationSource: row.classificationSource, classificationConfidence: row.classificationConfidence, personId: moved.get(row.id) ?? row.personId,
    });
    if (!changed) continue;
    await db.transaction.update({
      where: { id: row.id },
      data: {
        category: next.category, subcategory: next.subcategory, merchantName: next.merchantName,
        classificationSource: next.classificationSource, classificationConfidence: next.classificationConfidence, personId: next.personId,
      },
    });
    if (next.classificationSource === "user" && !sameLabel(row, next)) relabelled.push(row.id);
  }

  // The owner has now answered for these rows: AI suggestions for them are settled.
  const pending = await db.categorySuggestion.findMany({ where: { userId, status: "pending", transactionId: { in: relabelled } }, include: { transaction: true } });
  const now = new Date();
  for (const s of pending) {
    const status = s.category === s.transaction.category && (s.subcategory ?? null) === (s.transaction.subcategory ?? null) ? "confirmed" : "superseded";
    await db.categorySuggestion.update({ where: { id: s.id }, data: { status, decidedAt: now } });
  }

  const ids = changes.map((c) => c.id);
  if (person.relationship === "me") await pairOwnTransfers(userId);
  else if (ids.length) await unpairContradicted(userId, ids);

  const state: BatchState = { restore: opts.restore, remove: opts.remove, suggestions: pending.map((s) => s.id) };
  const removedRules: RemovedRule[] = retired.map((r) => ({ pattern: r.pattern, canonicalName: r.canonicalName, category: r.category, subcategory: r.subcategory }));
  const batch = await db.peopleBatch.create({
    data: { userId, personId, label: opts.label, changes: JSON.stringify(changes), before: JSON.stringify(state), removedRules: JSON.stringify(removedRules) },
  });
  return { personId, batchId: batch.id, changed: changes.length };
}

/** Adds someone the owner knows ("My wife is Gift Adebayo Ojo") and labels their payments. */
export async function createPerson(userId: string, input: PersonInput): Promise<ApplyResult> {
  const displayName = tidyName(input.displayName);
  if (!nameWords(displayName).length) throw new PeopleInputError("a name is required");
  const relationship = validRelationship(input.relationship);
  const key = aliasKey(displayName);
  const existing = (await loadKnownPeople(userId)).find((p) => p.aliases.some((a) => !a.rejected && a.key === key));
  if (existing) return updatePerson(userId, existing.id, { relationship, note: input.note, vendorCategory: input.vendorCategory, vendorSubcategory: input.vendorSubcategory, addAliases: input.aliases });
  const person = await db.person.create({
    data: {
      userId, displayName: titleCase(displayName), relationship, note: input.note?.trim() || null,
      vendorCategory: relationship === "vendor" ? input.vendorCategory ?? null : null,
      vendorSubcategory: relationship === "vendor" ? input.vendorSubcategory ?? null : null,
    },
  });
  for (const name of [displayName, ...(input.aliases ?? [])]) await addAlias(userId, person.id, name);
  return relabel(userId, person.id, { label: `Added ${person.displayName} (${relationshipInfo(relationship).short})`, restore: [], remove: [person.id] });
}

/** Reads lines like "My wife is …" and adds each person. Unread lines come back for the owner to fix. */
export async function addPeopleFromText(userId: string, text: string): Promise<{ added: ApplyResult[]; unread: string[] }> {
  const parsed = parsePeopleText(text);
  const added: ApplyResult[] = [];
  for (const p of parsed.people) {
    added.push(await createPerson(userId, {
      displayName: p.name, relationship: p.relationship, note: p.word, vendorCategory: p.vendor?.category, vendorSubcategory: p.vendor?.subcategory,
    }));
  }
  return { added, unread: parsed.unread };
}

export async function updatePerson(userId: string, personId: string, patch: PersonPatch): Promise<ApplyResult> {
  const [before] = await snapshot(userId, [personId]);
  if (!before) throw new PersonNotFoundError("person not found");
  const relationship = patch.relationship !== undefined ? validRelationship(patch.relationship) : (before.relationship as Relationship);
  const vendor = relationship === "vendor";
  await db.person.update({
    where: { id: personId },
    data: {
      ...(patch.displayName !== undefined && nameWords(patch.displayName).length && { displayName: titleCase(tidyName(patch.displayName)) }),
      relationship,
      ...(patch.note !== undefined && { note: patch.note?.trim() || null }),
      vendorCategory: vendor ? (patch.vendorCategory !== undefined ? patch.vendorCategory : before.vendorCategory) : null,
      vendorSubcategory: vendor ? (patch.vendorSubcategory !== undefined ? patch.vendorSubcategory : before.vendorSubcategory) : null,
    },
  });
  if (patch.displayName && nameWords(patch.displayName).length) await addAlias(userId, personId, patch.displayName);
  for (const name of patch.addAliases ?? []) await addAlias(userId, personId, name);
  for (const name of patch.rejectAliases ?? []) await addAlias(userId, personId, name, true);
  const forget = (patch.removeAliases ?? []).map(aliasKey).filter(Boolean);
  if (forget.length) await db.personAlias.deleteMany({ where: { personId, key: { in: forget } } });

  const parts = [
    patch.relationship && patch.relationship !== before.relationship && `now ${relationshipInfo(relationship).short}`,
    patch.addAliases?.length && `added ${patch.addAliases.join(", ")}`,
    patch.rejectAliases?.length && `${patch.rejectAliases.join(", ")} is someone else`,
    patch.removeAliases?.length && `removed ${patch.removeAliases.join(", ")}`,
  ].filter(Boolean);
  const name = patch.displayName ? titleCase(tidyName(patch.displayName)) : before.displayName;
  return relabel(userId, personId, { label: `${name}: ${parts.join("; ") || "updated"}`, restore: [before], remove: [] });
}

/** Two entries that are one person: the second's spellings and payments move to the first. */
export async function mergePeople(userId: string, targetId: string, sourceId: string): Promise<ApplyResult> {
  if (targetId === sourceId) throw new PeopleInputError("pick two different people");
  const before = await snapshot(userId, [targetId, sourceId]);
  const target = before.find((p) => p.id === targetId), source = before.find((p) => p.id === sourceId);
  if (!target || !source) throw new PersonNotFoundError("person not found");
  for (const a of [{ name: source.displayName, rejected: false }, ...source.aliases]) await addAlias(userId, targetId, a.name, a.rejected);
  const rows = await db.transaction.findMany({ where: { userId, personId: sourceId }, select: { id: true } });
  await db.transaction.updateMany({ where: { userId, personId: sourceId }, data: { personId: targetId } });
  await db.person.delete({ where: { id: sourceId } });
  return relabel(userId, targetId, {
    label: `Merged ${source.displayName} into ${target.displayName}`, restore: before, remove: [], moved: new Map(rows.map((r) => [r.id, sourceId])),
  });
}

/** Removes someone. Their payments keep their labels unless the labels came from the relationship. */
export async function deletePerson(userId: string, personId: string): Promise<ApplyResult> {
  const [before] = await snapshot(userId, [personId]);
  if (!before) throw new PersonNotFoundError("person not found");
  const rows = await db.transaction.findMany({ where: { userId, personId } });
  await db.person.delete({ where: { id: personId } });
  const [rules, owners] = await Promise.all([loadUserRules(userId), loadOwners(userId)]);
  const changes: RowBefore[] = [];
  for (const row of rows) {
    const type = row.type as "DEBIT" | "CREDIT";
    changes.push({ id: row.id, category: row.category, subcategory: row.subcategory, merchantName: row.merchantName, classificationSource: row.classificationSource, classificationConfidence: row.classificationConfidence, personId });
    const fromRelationship = row.classificationSource === "user" && sameLabel(row, labelFor(before, type));
    if (!fromRelationship) continue;
    const c = categorize({ description: row.description, type }, rules, owners);
    await db.transaction.update({
      where: { id: row.id },
      data: { category: c.category, subcategory: c.subcategory ?? null, classificationSource: c.source, classificationConfidence: c.confidence, personId: c.personId ?? null },
    });
  }
  const state: BatchState = { restore: [before], remove: [], suggestions: [] };
  const batch = await db.peopleBatch.create({ data: { userId, personId, label: `Removed ${before.displayName}`, changes: JSON.stringify(changes), before: JSON.stringify(state) } });
  return { personId, batchId: batch.id, changed: changes.length };
}

/** Puts people, rules and transactions back as they were before a batch. Newest first only. */
export async function undoPeopleBatch(userId: string, batchId?: string): Promise<{ batchId: string; restored: number; label: string }> {
  const batch = batchId
    ? await db.peopleBatch.findFirst({ where: { id: batchId, userId, undoneAt: null } })
    : await db.peopleBatch.findFirst({ where: { userId, undoneAt: null }, orderBy: { createdAt: "desc" } });
  if (!batch) throw new PersonNotFoundError("nothing to undo");
  const newer = await db.peopleBatch.findFirst({ where: { userId, undoneAt: null, createdAt: { gt: batch.createdAt }, id: { not: batch.id } } });
  if (newer) throw new PeopleInputError("undo the newer changes first");

  const state = JSON.parse(batch.before ?? "{}") as Partial<BatchState>;
  const changes = JSON.parse(batch.changes) as RowBefore[];
  const removedRules = JSON.parse(batch.removedRules) as RemovedRule[];

  if (state.remove?.length) await db.person.deleteMany({ where: { userId, id: { in: state.remove } } });
  for (const p of state.restore ?? []) {
    const data = { displayName: p.displayName, relationship: p.relationship, note: p.note, vendorCategory: p.vendorCategory, vendorSubcategory: p.vendorSubcategory };
    await db.person.upsert({ where: { id: p.id }, update: data, create: { id: p.id, userId, ...data, createdAt: new Date(p.createdAt) } });
    await db.personAlias.deleteMany({ where: { personId: p.id } });
    for (const a of p.aliases) await db.personAlias.create({ data: { userId, personId: p.id, name: a.name, key: a.key, rejected: a.rejected } });
  }
  const live = new Set((await db.person.findMany({ where: { userId }, select: { id: true } })).map((p) => p.id));
  for (const r of changes) {
    await db.transaction.updateMany({
      where: { userId, id: r.id },
      data: {
        category: r.category, subcategory: r.subcategory, merchantName: r.merchantName, classificationSource: r.classificationSource,
        classificationConfidence: r.classificationConfidence, personId: r.personId && live.has(r.personId) ? r.personId : null,
      },
    });
  }
  for (const rule of removedRules) {
    await db.merchantAlias.upsert({
      where: { userId_pattern: { userId, pattern: rule.pattern } },
      update: { canonicalName: rule.canonicalName, category: rule.category, subcategory: rule.subcategory },
      create: { userId, ...rule },
    });
  }
  if (state.suggestions?.length) await db.categorySuggestion.updateMany({ where: { userId, id: { in: state.suggestions } }, data: { status: "pending", decidedAt: null } });
  await db.peopleBatch.update({ where: { id: batch.id }, data: { undoneAt: new Date() } });
  const ids = changes.map((c) => c.id);
  if (changes.some((c) => c.category === OWN_TRANSFER)) await pairOwnTransfers(userId);
  else if (ids.length) await unpairContradicted(userId, ids);
  return { batchId: batch.id, restored: changes.length, label: batch.label };
}

// ---- Listing ----

export interface PersonMonth {
  /** "2026-09", Lagos time. */
  month: string;
  inMinor: bigint;
  outMinor: bigint;
}

export interface PersonSummary {
  id: string;
  displayName: string;
  relationship: Relationship;
  relationshipLabel: string;
  note: string | null;
  vendorCategory: string | null;
  vendorSubcategory: string | null;
  aliases: { name: string; rejected: boolean }[];
  /** The label payments to them get. */
  category: string | null;
  subcategory: string | null;
  count: number;
  inMinor: bigint;
  outMinor: bigint;
  lastDate: string | null;
  months: PersonMonth[];
}

export interface PeopleOverview {
  people: PersonSummary[];
  /** The newest change, if it can still be undone. */
  undo?: { batchId: string; label: string; changed: number; createdAt: string };
}

const lagosMonth = (d: Date) => new Date(d.getTime() + 3600_000).toISOString().slice(0, 7);

function lastMonths(now: Date, n: number): string[] {
  const out: string[] = [];
  const d = new Date(now.getTime() + 3600_000);
  for (let i = 0; i < n; i++) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return out;
}

export async function listPeople(userId: string, now = new Date(), months = 6): Promise<PeopleOverview> {
  const [people, rows, latest] = await Promise.all([
    db.person.findMany({ where: { userId }, include: { aliases: { orderBy: { createdAt: "asc" } } }, orderBy: { createdAt: "asc" } }),
    db.transaction.findMany({ where: { userId, personId: { not: null } }, select: { personId: true, type: true, amountMinor: true, transactionDate: true } }),
    db.peopleBatch.findFirst({ where: { userId, undoneAt: null }, orderBy: { createdAt: "desc" } }),
  ]);
  const window = lastMonths(now, months);
  const list = people.map((p): PersonSummary => {
    const mine = rows.filter((r) => r.personId === p.id);
    const byMonth = new Map(window.map((m) => [m, { month: m, inMinor: 0n, outMinor: 0n }]));
    let inMinor = 0n, outMinor = 0n, last: Date | undefined;
    for (const r of mine) {
      if (r.type === "CREDIT") inMinor += r.amountMinor;
      else outMinor += r.amountMinor;
      if (!last || r.transactionDate > last) last = r.transactionDate;
      const m = byMonth.get(lagosMonth(r.transactionDate));
      if (m) {
        if (r.type === "CREDIT") m.inMinor += r.amountMinor;
        else m.outMinor += r.amountMinor;
      }
    }
    const label = labelFor(p, "DEBIT");
    const relationship = (isRelationship(p.relationship) ? p.relationship : "other") as Relationship;
    return {
      id: p.id, displayName: p.displayName, relationship, relationshipLabel: relationshipInfo(relationship).label, note: p.note,
      vendorCategory: p.vendorCategory, vendorSubcategory: p.vendorSubcategory,
      aliases: p.aliases.map((a) => ({ name: a.name, rejected: a.rejected })),
      category: label?.category ?? null, subcategory: label?.subcategory ?? null,
      count: mine.length, inMinor, outMinor, lastDate: last ? lagosMonth(last) + new Date(last.getTime() + 3600_000).toISOString().slice(7, 10) : null,
      months: [...byMonth.values()],
    };
  });
  list.sort((a, b) => (b.outMinor + b.inMinor > a.outMinor + a.inMinor ? 1 : b.outMinor + b.inMinor < a.outMinor + a.inMinor ? -1 : a.displayName.localeCompare(b.displayName)));
  const undo = latest ? { batchId: latest.id, label: latest.label, changed: (JSON.parse(latest.changes) as unknown[]).length, createdAt: latest.createdAt.toISOString() } : undefined;
  return { people: list, ...(undo && { undo }) };
}

export async function knownPerson(userId: string, personId: string): Promise<KnownPerson | undefined> {
  return (await loadKnownPeople(userId)).find((p) => p.id === personId);
}
