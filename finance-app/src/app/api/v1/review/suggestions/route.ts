import { SuggestionNotFoundError, confirmSuggestion, dismissSuggestion } from "@/core/ai/suggestions";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { id, action: "confirm" | "dismiss" }: answer one AI suggestion from Review.
 * Confirm saves the label as a rule for the payee and relabels matching payments; returns rows updated.
 */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { id, action } = parsed.body;
  if (typeof id !== "string" || !id || id.length > 40) return apiError(400, "id is required");
  if (action !== "confirm" && action !== "dismiss") return apiError(400, 'action must be "confirm" or "dismiss"');
  try {
    const updated = action === "confirm" ? await confirmSuggestion(auth.user.id, id) : await dismissSuggestion(auth.user.id, id);
    return apiJson({ updated });
  } catch (e) {
    if (e instanceof SuggestionNotFoundError) return apiError(404, "Suggestion not found or already answered");
    throw e;
  }
}
