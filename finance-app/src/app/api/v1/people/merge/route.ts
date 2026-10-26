import { listPeople, mergePeople } from "@/core/people";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";
import { peopleError } from "@/lib/mobile/people";
import { peopleJson } from "@/lib/mobile/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { targetId, sourceId }: the second person is the first. Spellings and payments move over (undoable). */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { targetId, sourceId } = parsed.body;
  if (typeof targetId !== "string" || typeof sourceId !== "string" || !targetId || !sourceId) return apiError(400, "targetId and sourceId are required");
  try {
    const res = await mergePeople(auth.user.id, targetId, sourceId);
    return apiJson({ updated: res.changed, ...peopleJson(await listPeople(auth.user.id)) });
  } catch (e) {
    return peopleError(e);
  }
}
