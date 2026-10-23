import { parseAmountInput } from "./affordability";
import { canonicalLender } from "./categorize";
import { LENDER_NAMES, checkLoanFields, cleanNotes, parseDay, type LoanFields } from "./loans";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim().slice(0, 400);

/** The web Loans form: amounts as people type them ("1,275,846.91", "1.28m"), days from a date input. */
export function loanFieldsFromForm(form: FormData): { fields: LoanFields } | { error: string } {
  const lender = canonicalLender(text(form, "lender"));
  if (!lender) return { error: `Pick a lender Ledger knows: ${LENDER_NAMES.join(", ")}.` };
  const rawBalance = text(form, "outstanding");
  const outstandingMinor = /^[₦n]?\s*0+(\.0+)?$/i.test(rawBalance) ? 0n : parseAmountInput(rawBalance);
  if (outstandingMinor === null) return { error: "Enter the balance left from your loan app, like 1,275,846.91." };
  const rawInstalment = text(form, "instalment");
  const instalmentMinor = rawInstalment ? parseAmountInput(rawInstalment) : null;
  if (instalmentMinor === null && rawInstalment) return { error: "Enter the monthly instalment, like 120,000, or leave it empty." };
  const count = (key: string) => {
    const raw = text(form, key);
    return !raw ? null : /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  };
  const instalmentsPaid = count("paid"), instalmentsTotal = count("total");
  if (Number.isNaN(instalmentsPaid) || Number.isNaN(instalmentsTotal)) return { error: "Instalments must be whole numbers, like 11 of 12." };
  const date = (key: string) => {
    const raw = text(form, key);
    return !raw ? null : parseDay(raw) ?? undefined;
  };
  const nextDueDate = date("nextDue"), endDate = date("endDate");
  if (nextDueDate === undefined || endDate === undefined) return { error: "Pick the dates from the calendar, or leave them empty." };
  const fields: LoanFields = { lender, outstandingMinor, instalmentMinor, instalmentsPaid, instalmentsTotal, nextDueDate, endDate, notes: cleanNotes(form.get("notes")) };
  const error = checkLoanFields(fields);
  return error ? { error } : { fields };
}
