import { deletePerson, listPeople, updatePerson } from "@/core/people";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";
import { peopleError, personPatchFromJson } from "@/lib/mobile/people";
import { peopleJson } from "@/lib/mobile/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH { relationship?, displayName?, note?, vendorCategory?, vendorSubcategory?, addAliases?, rejectAliases?, removeAliases? }.
 * Relabels their payments (undoable) and returns the updated list.
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const read = personPatchFromJson(parsed.body);
  if ("error" in read) return apiError(400, read.error);
  try {
    const res = await updatePerson(auth.user.id, id, read.patch);
    return apiJson({ updated: res.changed, ...peopleJson(await listPeople(auth.user.id)) });
  } catch (e) {
    return peopleError(e);
  }
}

/** DELETE: forget this person. Labels that came from the relationship go back to the rules (undoable). */
export async function DELETE(req: Request, { params }: Ctx) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const { id } = await params;
  try {
    const res = await deletePerson(auth.user.id, id);
    return apiJson({ updated: res.changed, ...peopleJson(await listPeople(auth.user.id)) });
  } catch (e) {
    return peopleError(e);
  }
}
