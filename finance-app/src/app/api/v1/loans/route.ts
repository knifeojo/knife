import { LENDER_NAMES, createLoan, getLoan, listLoans, loanFieldsFromJson, loanJson } from "@/core/loans";
import { db } from "@/lib/db";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LOANS = 50;

/** { loans: [...], lenders: ["FairMoney", "Renmoney", ...] } The lenders are the names a loan can be filed under. */
export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  return apiJson({ loans: (await listLoans(auth.user.id)).map(loanJson), lenders: LENDER_NAMES });
}

/** POST { lender, outstandingMinor: "127584691", instalmentMinor?, instalmentsPaid?, instalmentsTotal?, nextDueDate?: "YYYY-MM-DD", endDate?, notes? } */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const read = loanFieldsFromJson(parsed.body);
  if ("error" in read) return apiError(400, read.error);
  if ((await db.loan.count({ where: { userId: auth.user.id } })) >= MAX_LOANS) return apiError(409, `Ledger keeps up to ${MAX_LOANS} loans. Delete an old one first.`);
  const loan = await createLoan(auth.user.id, read.fields);
  return apiJson(loanJson((await getLoan(auth.user.id, loan.id))!), 201);
}
