import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { formatMoney } from "@/lib/money";
import { canonicalLender } from "@/core/categorize";
import { LENDER_NAMES, listLoans, type LoanView } from "@/core/loans";
import { Card, PageHeader, lagosDateLabel } from "@/components/ui";
import { deleteLoanAction, setLoanStatusAction } from "./actions";
import { CountRepaymentsButton, LoanForm, type LoanDefaults } from "./loan-form";

const money = (m: bigint) => formatMoney(m);
const day = (d: Date) => lagosDateLabel(d);
/** Kobo to what the form shows: 127584691n -> "1275846.91". */
const naira = (m: bigint | null) => (m === null ? undefined : `${m / 100n}${m % 100n ? `.${String(m % 100n).padStart(2, "0")}` : ""}`);
const isoDay = (d: Date | null) => d?.toISOString().slice(0, 10);

export default async function Loans({ searchParams }: { searchParams: Promise<{ lender?: string }> }) {
  const user = await requireUser();
  const [loans, { lender }] = await Promise.all([listLoans(user.id), searchParams]);
  const open = loans.filter((v) => v.loan.status !== "closed");
  const closed = loans.filter((v) => v.loan.status === "closed");
  const prefill = lender ? canonicalLender(lender) : undefined;
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader
        title="Loans"
        subtitle="Bank statements show your repayments, never what is left. Copy the balance from your loan app and Can I afford it? uses the real figure and stops counting the instalment after the last payment."
      />
      <Card title={open.length ? "Add another loan" : "Add a loan"}>
        <details open={!open.length || !!prefill}>
          <summary className="cursor-pointer text-sm text-brand font-medium">{prefill ? `Add your ${prefill} balance` : "Enter it from your loan app"}</summary>
          <div className="mt-4">
            <LoanForm lenders={LENDER_NAMES} initial={{ lender: prefill }} submitLabel="Add loan" />
          </div>
        </details>
      </Card>
      {open.map((v) => <LoanCard key={v.loan.id} v={v} />)}
      {closed.length > 0 && (
        <Card title="Closed">
          <ul className="text-sm divide-y divide-border">
            {closed.map(({ loan }) => (
              <li key={loan.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span>{loan.lender}{loan.closedAt ? `, closed ${day(loan.closedAt)}` : ""}{loan.notes ? ` · ${loan.notes}` : ""}</span>
                <span className="flex gap-2">
                  <StatusButton id={loan.id} status="open" label="Reopen" />
                  <DeleteButton id={loan.id} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <p className="text-xs text-ink-3">
        Instalments are monthly. Ledger matches repayments on your statements to a loan by lender, and asks before counting them. Back to <Link href="/app/afford" className="text-brand underline">Can I afford it?</Link>
      </p>
    </div>
  );
}

function LoanCard({ v }: { v: LoanView }) {
  const { loan, payoff, since, sinceMinor } = v;
  const defaults: LoanDefaults = {
    id: loan.id, lender: loan.lender, outstanding: naira(loan.outstandingMinor), instalment: naira(loan.instalmentMinor),
    paid: loan.instalmentsPaid?.toString(), total: loan.instalmentsTotal?.toString(),
    nextDue: isoDay(loan.nextDueDate), endDate: isoDay(loan.endDate), notes: loan.notes ?? undefined,
  };
  const facts = [
    loan.instalmentMinor !== null && `${money(loan.instalmentMinor)} a month`,
    loan.instalmentsPaid !== null && loan.instalmentsTotal !== null && `${loan.instalmentsPaid} of ${loan.instalmentsTotal} paid`,
    loan.nextDueDate && `next due ${day(loan.nextDueDate)}`,
    payoff && `last payment ${day(payoff)}${loan.endDate ? "" : " (worked out)"}`,
  ].filter(Boolean);
  return (
    <section id={`loan-${loan.id}`} className="card p-5 space-y-3 scroll-mt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{loan.lender}</h2>
        <span className="text-xs text-ink-3">Entered {day(loan.balanceAsOf)}{v.lastUpdate ? ` · Last update ${day(v.lastUpdate.at)}` : ""}</span>
      </div>
      <p>
        {loan.outstandingMinor === null ? (
          <span className="text-2xl font-semibold tracking-tight text-ink-2">Balance not seen</span>
        ) : (
          <><span className="num text-2xl font-semibold tracking-tight text-brand">{money(loan.outstandingMinor)}</span> <span className="text-sm text-ink-2">left</span></>
        )}
      </p>
      {facts.length > 0 && <p className="text-sm text-ink-2">{facts.join(" · ")}</p>}
      {loan.notes && <p className="text-sm text-ink-3">{loan.notes}</p>}
      {since.length > 0 && (
        <div className="rounded-lg bg-brand-soft px-3 py-2.5 space-y-2">
          <p className="text-sm">
            Out of date: your bank shows {since.length === 1 ? "a repayment" : `${since.length} repayments`} of {money(sinceMinor)} to {loan.lender} since you entered this
            (last on {day(since[since.length - 1].date)}). Count {since.length === 1 ? "it" : "them"} to bring instalments paid and the balance up to date, or edit the figures from your loan app.
          </p>
          <CountRepaymentsButton id={loan.id} />
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-sm text-brand font-medium">Edit</summary>
        <div className="mt-4"><LoanForm lenders={LENDER_NAMES} initial={defaults} submitLabel="Save" /></div>
      </details>
      <div className="flex gap-2">
        <StatusButton id={loan.id} status="closed" label="Close: paid off" />
        <DeleteButton id={loan.id} />
      </div>
    </section>
  );
}

function StatusButton({ id, status, label }: { id: string; status: "open" | "closed"; label: string }) {
  return (
    <form action={setLoanStatusAction}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={status} />
      <button className="btn btn-secondary h-8 px-3 text-sm">{label}</button>
    </form>
  );
}

function DeleteButton({ id }: { id: string }) {
  return (
    <form action={deleteLoanAction}>
      <input type="hidden" name="id" value={id} />
      <button className="btn btn-ghost h-8 px-3 text-sm text-danger">Delete</button>
    </form>
  );
}
