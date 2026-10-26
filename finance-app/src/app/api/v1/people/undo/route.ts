import { listPeople, undoPeopleBatch } from "@/core/people";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";
import { peopleError } from "@/lib/mobile/people";
import { peopleJson } from "@/lib/mobile/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { batchId? }: undo the newest People change (or that one, if it is the newest). */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { batchId } = parsed.body;
  if (batchId !== undefined && batchId !== null && typeof batchId !== "string") return apiError(400, "batchId must be a string");
  try {
    const res = await undoPeopleBatch(auth.user.id, (batchId as string | null) ?? undefined);
    return apiJson({ undone: res.label, restored: res.restored, ...peopleJson(await listPeople(auth.user.id)) });
  } catch (e) {
    return peopleError(e);
  }
}
