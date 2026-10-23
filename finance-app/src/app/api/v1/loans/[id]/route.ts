import { deleteLoan, getLoan, loanFieldsFromJson, loanJson, setLoanStatus, updateLoan } from "@/core/loans";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH { status: "closed" | "open" } closes or reopens a loan. Any other body is a full edit with the same
 * fields as POST /api/v1/loans, plus an optional status.
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { status, ...rest } = parsed.body;
  if (status !== undefined && status !== "open" && status !== "closed") return apiError(400, "status must be \"open\" or \"closed\"");
  if (Object.keys(rest).length) {
    const read = loanFieldsFromJson(rest);
    if ("error" in read) return apiError(400, read.error);
    if (!(await updateLoan(auth.user.id, id, read.fields))) return apiError(404, "Loan not found");
  } else if (status === undefined) {
    return apiError(400, "Send the loan's fields, or a status");
  }
  if (status !== undefined && !(await setLoanStatus(auth.user.id, id, status))) return apiError(404, "Loan not found");
  const view = await getLoan(auth.user.id, id);
  return view ? apiJson(loanJson(view)) : apiError(404, "Loan not found");
}

export async function DELETE(req: Request, { params }: Ctx) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const { id } = await params;
  return (await deleteLoan(auth.user.id, id)) ? apiJson({ ok: true }) : apiError(404, "Loan not found");
}
