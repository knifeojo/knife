import { dismissLoanCleared } from "@/core/loan-moments";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { id } hides one "Loan cleared" card. The moment itself is not fired again. */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const id = parsed.body.id;
  if (typeof id !== "string" || !id.trim()) return apiError(400, "id is required");
  const ok = await dismissLoanCleared(auth.user.id, id.trim());
  return ok ? apiJson({ ok: true }) : apiError(404, "Loan cleared notice not found");
}
