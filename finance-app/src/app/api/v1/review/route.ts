import { ALL_CATEGORIES } from "@/core/categorize";
import { QUESTION_KINDS, answerQuestion, buildQuestions, type QuestionKind } from "@/core/review";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";
import { minor } from "@/lib/mobile/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: the same "Help Ledger get this right" questions as the web Review page. */
export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const questions = await buildQuestions(auth.user.id);
  return apiJson({
    questions: questions.map((q) => ({
      kind: q.kind,
      key: q.key,
      title: q.title,
      prompt: q.prompt,
      totalMinor: minor(q.totalMinor),
      count: q.count,
      examples: q.examples,
      options: q.options.map((o) => ({ value: o.value, label: o.label, category: o.category, subcategory: o.subcategory ?? null })),
      currentCategory: q.currentCategory ?? null,
      hint: q.hint ?? null,
      /** Holder and conversion questions take only the listed options. */
      allowsOther: q.kind !== "holder" && q.kind !== "conversion",
    })),
    totalMinor: minor(questions.reduce((t, q) => t + q.totalMinor, 0n)),
    categories: ALL_CATEGORIES,
  });
}

/** POST { kind, key, value, otherText?, otherCategory? }: answer one question. value "unknown" is "Can't remember". */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { kind, key, value, otherText, otherCategory } = parsed.body;
  if (typeof kind !== "string" || !QUESTION_KINDS.includes(kind as QuestionKind)) return apiError(400, "Unknown question kind");
  if (typeof key !== "string" || !key.trim() || key.length > 120) return apiError(400, "key is required");
  if (typeof value !== "string" || !value || value.length > 40) return apiError(400, "value is required");
  const text = typeof otherText === "string" ? otherText.slice(0, 60) : "";
  if (value === "other" && !text.trim()) return apiError(400, "Type an answer for Other");
  if (otherCategory !== undefined && otherCategory !== null && (typeof otherCategory !== "string" || !ALL_CATEGORIES.includes(otherCategory))) {
    return apiError(400, "Unknown category");
  }
  try {
    const updated = await answerQuestion(auth.user.id, kind as QuestionKind, key, value, value === "other" ? { text, category: (otherCategory as string | null) ?? undefined } : undefined);
    return apiJson({ updated });
  } catch (e) {
    if (e instanceof Error && e.message === "unknown answer") return apiError(400, "Unknown answer for this question");
    throw e;
  }
}
