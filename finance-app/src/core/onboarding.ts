import { db } from "@/lib/db";
import { createPerson } from "./people";
import { RELATIONSHIPS } from "./people-match";
import { topUnknownPeople, type TopPerson } from "./review";

// First-run "Who are your people?": a short, skippable form. Names become Person records on this
// machine and are never sent to a cloud model. After the first upload, "You send money to these
// people most" offers one-tap answers for the largest unknown individuals.

export const TRUST_NOTE = "These names stay on your device and are never sent to the cloud.";

export const RELATIONSHIP_STATUSES = [
  { value: "single", label: "Single" },
  { value: "married", label: "Married" },
  { value: "engaged", label: "Engaged" },
  { value: "relationship", label: "In a relationship" },
  { value: "private", label: "Prefer not to say" },
] as const;

export type RelationshipStatus = (typeof RELATIONSHIP_STATUSES)[number]["value"];

export function isRelationshipStatus(v: unknown): v is RelationshipStatus {
  return typeof v === "string" && RELATIONSHIP_STATUSES.some((s) => s.value === v);
}

/** Commas, "and", slashes or new lines: "Ada Bello, Tunde Bello" or "Ada Bello and Tunde Bello". */
export function splitNames(s: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of s.split(/[\n;,/]+|\s+and\s+/i)) {
    const name = raw.replace(/\s+/g, " ").trim().slice(0, 80);
    if (name.length < 2) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export interface OnboardingState {
  needsOnboarding: boolean;
  ownName: string | null;
  relationshipStatus: string | null;
  trustNote: string;
  topPeople: { show: boolean; people: TopPerson[] };
}

export async function onboardingState(userId: string): Promise<OnboardingState> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { name: true, isDemo: true, onboardedAt: true, relationshipStatus: true, topPeopleDoneAt: true },
  });
  const [txCount, peopleCount] = await Promise.all([
    db.transaction.count({ where: { userId } }),
    db.person.count({ where: { userId } }),
  ]);
  const needsOnboarding = !user.onboardedAt && !user.isDemo && txCount === 0 && peopleCount === 0;
  const people = user.isDemo || user.topPeopleDoneAt ? [] : await topUnknownPeople(userId, 6);
  return {
    needsOnboarding,
    ownName: user.name,
    relationshipStatus: user.relationshipStatus,
    trustNote: TRUST_NOTE,
    topPeople: { show: !user.isDemo && !user.topPeopleDoneAt && people.length > 0, people },
  };
}

export interface OnboardingInput {
  skip?: boolean;
  ownName?: string;
  relationshipStatus?: string | null;
  partners?: string[];
  parents?: string[];
  siblings?: string[];
  supported?: string[];
}

/** Saves (or skips) the first-run form. Each name becomes a Person; existing spellings are updated, not duplicated. */
export async function saveOnboarding(userId: string, input: OnboardingInput): Promise<{ added: number }> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
  const status = input.relationshipStatus && isRelationshipStatus(input.relationshipStatus) ? input.relationshipStatus : undefined;
  const ownName = input.ownName?.replace(/\s+/g, " ").trim().slice(0, 80);
  let added = 0;
  if (ownName && ownName.length >= 2 && !user.name) {
    await db.user.update({ where: { id: userId }, data: { name: ownName } });
    await createPerson(userId, { displayName: ownName, relationship: "me" });
    added++;
  }
  if (!input.skip) {
    const partnerNote = status && status !== "single" && status !== "private" ? status : undefined;
    const groups: { names: string[]; relationship: string; note?: string }[] = [
      { names: input.partners ?? [], relationship: "spouse", note: partnerNote },
      { names: input.parents ?? [], relationship: "parent" },
      { names: input.siblings ?? [], relationship: "sibling" },
      { names: input.supported ?? [], relationship: "extended", note: "someone they support regularly" },
    ];
    for (const g of groups) {
      for (const name of g.names) {
        if (name.replace(/\s+/g, " ").trim().length < 2) continue;
        await createPerson(userId, { displayName: name, relationship: g.relationship, note: g.note });
        added++;
      }
    }
  }
  await db.user.update({
    where: { id: userId },
    data: { onboardedAt: new Date(), ...(status && { relationshipStatus: status }) },
  });
  return { added };
}

export async function finishTopPeople(userId: string): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { topPeopleDoneAt: new Date() } });
}

export const ONBOARDING_RELATIONSHIPS = RELATIONSHIPS.map((r) => ({ value: r.value, label: r.label }));
