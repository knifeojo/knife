import { ALL_CATEGORIES } from "@/core/categorize";
import { addPeopleFromText, createPerson, listPeople } from "@/core/people";
import { RELATIONSHIPS } from "@/core/people-match";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";
import { peopleError, personInputFromJson } from "@/lib/mobile/people";
import { peopleJson } from "@/lib/mobile/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: "Your people" with aliases, totals per month (last 6, newest first) and the newest undoable change. */
export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  return apiJson({
    ...peopleJson(await listPeople(auth.user.id)),
    relationships: RELATIONSHIPS.map((r) => ({ value: r.value, label: r.label })),
    categories: ALL_CATEGORIES,
  });
}

/**
 * POST { text: "My wife is Gift Adebayo Ojo\nMy brother is Tunde Ojo" } adds everyone it can read;
 * POST { displayName, relationship, note?, aliases?, vendorCategory?, vendorSubcategory? } adds one person.
 * Either way their payments are relabelled now (undoable) and the updated list is returned.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const userId = auth.user.id;
  try {
    if (parsed.body.text !== undefined) {
      const text = parsed.body.text;
      if (typeof text !== "string" || !text.trim() || text.length > 2000) return apiError(400, "text is required");
      const res = await addPeopleFromText(userId, text);
      if (!res.added.length) return apiJson({ error: "Could not read a person. Try \"My wife is Gift Ojo\".", unread: res.unread }, 400);
      return apiJson({ added: res.added.length, updated: res.added.reduce((t, a) => t + a.changed, 0), unread: res.unread, ...peopleJson(await listPeople(userId)) }, 201);
    }
    const read = personInputFromJson(parsed.body);
    if ("error" in read) return apiError(400, read.error);
    const res = await createPerson(userId, read.input);
    return apiJson({ id: res.personId, updated: res.changed, ...peopleJson(await listPeople(userId)) }, 201);
  } catch (e) {
    return peopleError(e);
  }
}
