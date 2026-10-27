import { ALL_CATEGORIES } from "@/core/categorize";
import { QUESTION_KINDS, answerQuestion, type QuestionKind } from "@/core/review";
import { reviewWithSuggestions } from "@/core/ai/suggestions";
import { PeopleInputError, PersonNotFoundError } from "@/core/people";
import { RELATIONSHIPS, isRelationship } from "@/core/people-match";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";
import { minor, suggestionJson } from "@/lib/mobile/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: the same "Help Ledger get this right" questions and AI suggestions as the web Review page. */
export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const { questions, suggestions } = await reviewWithSuggestions(auth.user.id);
  return apiJson({
    questions: questions.map((q) => ({
      kind: q.kind,
      key: q.key,
      title: q.title,
      prompt: q.prompt,
      totalMinor: minor(q.totalMinor),
      count: q.count,
      examples: q.examples,
      /** group: "relationship" (one-tap answers about a person), "more" (behind Someone else), "control" (Skip, Not a person), or null. */
      options: q.options.map((o) => ({ value: o.value, label: o.label, category: o.category, subcategory: o.subcategory ?? null, group: o.group ?? null })),
      currentCategory: q.currentCategory ?? null,
      hint: q.hint ?? null,
      /** Answer one with { value: "other", otherText: words, otherCategory: category unless "Other" }. */
      narrationHints: (q.narrationHints ?? []).map((h) => ({ words: h.words, category: h.category, subcategory: h.subcategory })),
      /** Holder and conversion questions take only the listed options. */
      allowsOther: q.kind !== "holder" && q.kind !== "conversion" && q.kind !== "match",
      /** For questions about an individual: money both ways, last date and every spelling seen. Null otherwise. */
      person: q.person
        ? {
            inCount: q.person.inCount, inMinor: minor(q.person.inMinor), outCount: q.person.outCount, outMinor: minor(q.person.outMinor),
            lastDate: q.person.lastDate, variants: q.person.variants,
          }
        : null,
      /** Unlabelled money the answer would fix. People questions come first, sorted by this. */
      impactMinor: q.impactMinor !== undefined ? minor(q.impactMinor) : null,
      /** The relationship the AI proposes for this person ("spouse"). The owner confirms by answering "rel:spouse". */
      aiRelationship: q.aiRelationship ?? null,
      /** The AI's pick for this payee, shown pre-selected. Null when it has none. */
      aiSuggestion: q.aiSuggestion ? suggestionJson(q.aiSuggestion) : null,
      /** Ledger's own guess (same surname, a regular payment, money both ways). Null when it has none. */
      guess: q.guess
        ? {
            kind: q.guess.kind,
            reason: q.guess.reason,
            answers: q.guess.answers.map((a) => ({
              value: a.value,
              label: a.label,
              vendorCategory: a.vendorCategory ?? null,
              vendorSubcategory: a.vendorSubcategory ?? null,
            })),
          }
        : null,
    })),
    /** AI suggestions for payees no question covers. */
    suggestions: suggestions.map(suggestionJson),
    totalMinor: minor(questions.reduce((t, q) => t + q.totalMinor, 0n)),
    categories: ALL_CATEGORIES,
    relationships: RELATIONSHIPS.map((r) => ({ value: r.value, label: r.label })),
  });
}

/**
 * POST { kind, key, value, otherText?, otherCategory?, vendorCategory?, vendorSubcategory? }: answer one question.
 * value "unknown" is Skip / "Can't remember"; "not_person" stops asking about a name as a person;
 * "rel:<relationship>" saves the person (vendorCategory is what a vendor is paid for); "person:<id>" and
 * "no" answer a match question.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { kind, key, value, otherText, otherCategory, vendorCategory, vendorSubcategory } = parsed.body;
  if (typeof kind !== "string" || !QUESTION_KINDS.includes(kind as QuestionKind)) return apiError(400, "Unknown question kind");
  if (typeof key !== "string" || !key.trim() || key.length > 120) return apiError(400, "key is required");
  if (typeof value !== "string" || !value || value.length > 40) return apiError(400, "value is required");
  const text = typeof otherText === "string" ? otherText.slice(0, 60) : "";
  if (value === "other" && !text.trim()) return apiError(400, "Type an answer for Other");
  if (otherCategory !== undefined && otherCategory !== null && (typeof otherCategory !== "string" || !ALL_CATEGORIES.includes(otherCategory))) {
    return apiError(400, "Unknown category");
  }
  if (value.startsWith("rel:") && !isRelationship(value.slice(4))) return apiError(400, "Unknown relationship");
  if (vendorCategory !== undefined && vendorCategory !== null && (typeof vendorCategory !== "string" || !ALL_CATEGORIES.includes(vendorCategory))) {
    return apiError(400, "Unknown category");
  }
  const vendor = value === "rel:vendor" && typeof vendorCategory === "string"
    ? { text: "", category: vendorCategory, subcategory: typeof vendorSubcategory === "string" ? vendorSubcategory.slice(0, 40) : undefined }
    : undefined;
  try {
    const updated = await answerQuestion(auth.user.id, kind as QuestionKind, key, value, value === "other" ? { text, category: (otherCategory as string | null) ?? undefined } : vendor);
    return apiJson({ updated });
  } catch (e) {
    if (e instanceof Error && e.message === "unknown answer") return apiError(400, "Unknown answer for this question");
    if (e instanceof PersonNotFoundError) return apiError(404, "Person not found");
    if (e instanceof PeopleInputError) return apiError(400, e.message);
    throw e;
  }
}
