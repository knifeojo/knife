import { finishTopPeople, isRelationshipStatus, onboardingState, saveOnboarding, splitNames, ONBOARDING_RELATIONSHIPS, RELATIONSHIP_STATUSES, TRUST_NOTE } from "@/core/onboarding";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";
import { minor } from "@/lib/mobile/serialize";
import type { TopPerson } from "@/core/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function namesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === "string" ? splitNames(x) : []));
  if (typeof v === "string") return splitNames(v);
  return [];
}

function guessJson(g: TopPerson["guess"]) {
  if (!g) return null;
  return {
    kind: g.kind,
    reason: g.reason,
    answers: g.answers.map((a) => ({
      value: a.value,
      label: a.label,
      vendorCategory: a.vendorCategory ?? null,
      vendorSubcategory: a.vendorSubcategory ?? null,
    })),
  };
}

function topPersonJson(p: TopPerson) {
  return {
    key: p.key,
    display: p.display,
    person: {
      inCount: p.person.inCount,
      inMinor: minor(p.person.inMinor),
      outCount: p.person.outCount,
      outMinor: minor(p.person.outMinor),
      lastDate: p.person.lastDate,
      variants: p.person.variants,
    },
    guess: guessJson(p.guess),
  };
}

function stateJson(state: Awaited<ReturnType<typeof onboardingState>>) {
  return {
    needsOnboarding: state.needsOnboarding,
    ownName: state.ownName,
    relationshipStatus: state.relationshipStatus,
    statuses: RELATIONSHIP_STATUSES.map((s) => ({ value: s.value, label: s.label })),
    trustNote: TRUST_NOTE,
    topPeople: { show: state.topPeople.show, people: state.topPeople.people.map(topPersonJson) },
    relationships: ONBOARDING_RELATIONSHIPS,
  };
}

/** GET: whether to show the first-run form and/or "You send money to these people most". */
export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  return apiJson(stateJson(await onboardingState(auth.user.id)));
}

/**
 * POST { skip: true } or { ownName?, relationshipStatus?, partner?, parents?, siblings?, supported? }
 * saves the first-run form. POST { topPeopleDone: true } closes the after-upload picker.
 * Names may be a string ("Ada, Tunde") or an array. One-tap answers for top people use POST /review.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  if (body.topPeopleDone === true) {
    await finishTopPeople(auth.user.id);
    return apiJson(stateJson(await onboardingState(auth.user.id)));
  }
  const status = body.relationshipStatus;
  if (status !== undefined && status !== null && status !== "" && !isRelationshipStatus(status)) {
    return apiError(400, "Unknown relationship status");
  }
  const ownName = typeof body.ownName === "string" ? body.ownName.slice(0, 80) : undefined;
  const { added } = await saveOnboarding(auth.user.id, {
    skip: body.skip === true,
    ownName,
    relationshipStatus: typeof status === "string" ? status : undefined,
    partners: namesOf(body.partner ?? body.partners),
    parents: namesOf(body.parents),
    siblings: namesOf(body.siblings),
    supported: namesOf(body.supported),
  });
  return apiJson({ added, ...stateJson(await onboardingState(auth.user.id)) });
}
