"use client";

import { useActionState } from "react";
import { countRepaymentsAction, saveLoanAction, type LoanState } from "./actions";

export interface LoanDefaults {
  id?: string;
  lender?: string;
  outstanding?: string;
  instalment?: string;
  paid?: string;
  total?: string;
  nextDue?: string;
  endDate?: string;
  notes?: string;
}

export function LoanForm({ lenders, initial = {}, submitLabel }: { lenders: readonly string[]; initial?: LoanDefaults; submitLabel: string }) {
  const [state, action, pending] = useActionState<LoanState, FormData>(saveLoanAction, undefined);
  const k = initial.id ?? "new";
  return (
    <form action={action} className="space-y-4">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="label">Lender</span>
          <select name="lender" required defaultValue={initial.lender ?? ""} className="input mt-1.5">
            <option value="" disabled>Pick your loan app</option>
            {lenders.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label">Balance left</span>
          <input name="outstanding" required inputMode="decimal" autoComplete="off" defaultValue={initial.outstanding} placeholder="1,250,000" className="input mt-1.5 num" aria-describedby={`bal-${k}`} />
          <span id={`bal-${k}`} className="mt-1 block text-xs text-ink-3">As your loan app shows it today.</span>
        </label>
      </div>
      <div className="grid sm:grid-cols-3 gap-4">
        <label className="block">
          <span className="label">Monthly instalment</span>
          <input name="instalment" inputMode="decimal" autoComplete="off" defaultValue={initial.instalment} placeholder="120,000" className="input mt-1.5 num" />
        </label>
        <label className="block">
          <span className="label">Instalments paid</span>
          <input name="paid" inputMode="numeric" autoComplete="off" defaultValue={initial.paid} placeholder="3" className="input mt-1.5 num" />
        </label>
        <label className="block">
          <span className="label">Out of</span>
          <input name="total" inputMode="numeric" autoComplete="off" defaultValue={initial.total} placeholder="6" className="input mt-1.5 num" />
        </label>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="label">Next payment due</span>
          <input name="nextDue" type="date" defaultValue={initial.nextDue} className="input mt-1.5" />
        </label>
        <label className="block">
          <span className="label">Last payment due</span>
          <input name="endDate" type="date" defaultValue={initial.endDate} className="input mt-1.5" aria-describedby={`end-${k}`} />
          <span id={`end-${k}`} className="mt-1 block text-xs text-ink-3">Leave empty and Ledger works it out from the instalments left.</span>
        </label>
      </div>
      <label className="block">
        <span className="label">Notes (optional)</span>
        <input name="notes" maxLength={300} autoComplete="off" defaultValue={initial.notes} placeholder="Car repair loan" className="input mt-1.5" />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn bg-brand text-brand-ink hover:opacity-90" disabled={pending}>{pending ? "Saving…" : submitLabel}</button>
        {state?.ok && <span className="text-sm text-brand" role="status">{state.ok}</span>}
        {state?.error && <span className="text-sm text-danger" role="alert">{state.error}</span>}
      </div>
    </form>
  );
}

export function CountRepaymentsButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState<LoanState, FormData>(countRepaymentsAction, undefined);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="id" value={id} />
      <button className="btn h-8 px-3 text-sm bg-brand text-brand-ink hover:opacity-90" disabled={pending}>{pending ? "Counting…" : "Count them"}</button>
      {state?.ok && <span className="text-sm" role="status">{state.ok}</span>}
      {state?.error && <span className="text-sm text-danger" role="alert">{state.error}</span>}
    </form>
  );
}
