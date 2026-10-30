"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { loanFieldsFromForm } from "@/core/loan-form";
import { countRepayments, createLoan, deleteLoan, setLoanStatus, updateLoan } from "@/core/loans";

const MAX_LOANS = 50;

export type LoanState = { ok?: string; error?: string } | undefined;

/** Adds a loan, or saves an edit when the form carries an id. */
export async function saveLoanAction(_: LoanState, form: FormData): Promise<LoanState> {
  const user = await requireUser();
  const read = loanFieldsFromForm(form);
  if ("error" in read) return { error: read.error };
  const id = String(form.get("id") ?? "");
  if (id) {
    if (!(await updateLoan(user.id, id, read.fields))) return { error: "That loan is no longer here." };
  } else {
    if ((await db.loan.count({ where: { userId: user.id } })) >= MAX_LOANS) return { error: `Ledger keeps up to ${MAX_LOANS} loans. Delete an old one first.` };
    await createLoan(user.id, read.fields);
  }
  revalidatePath("/app", "layout");
  return { ok: id ? "Saved." : `Added your ${read.fields.lender} loan. Can I afford it? now uses this balance.` };
}

export async function setLoanStatusAction(form: FormData) {
  const user = await requireUser();
  await setLoanStatus(user.id, String(form.get("id")), form.get("status") === "open" ? "open" : "closed");
  revalidatePath("/app", "layout");
}

export async function deleteLoanAction(form: FormData) {
  const user = await requireUser();
  await deleteLoan(user.id, String(form.get("id")));
  revalidatePath("/app", "layout");
}

/** Counts the statement repayments seen since the balance was entered. */
export async function countRepaymentsAction(_: LoanState, form: FormData): Promise<LoanState> {
  const user = await requireUser();
  const r = await countRepayments(user.id, String(form.get("id")));
  if (!r) return { error: "Nothing new to count." };
  revalidatePath("/app", "layout");
  const closed = r.loan.status === "closed" ? " That clears it, so it is now closed." : "";
  return { ok: `Counted ${formatMoney(r.repaidMinor)} repaid. Balance now ${formatMoney(r.loan.outstandingMinor ?? 0n)}.${closed} Check it against your loan app.` };
}
