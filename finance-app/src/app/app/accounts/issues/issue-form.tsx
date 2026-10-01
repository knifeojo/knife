"use client";

import { useActionState } from "react";
import { addIssueAction, ignoreIssueAction, type IssueState } from "@/app/app/actions";

export function IssueForm({ issueId, guess }: { issueId: string; guess: { date?: string; amount?: string; description: string } }) {
  const [state, action, pending] = useActionState<IssueState, FormData>(addIssueAction, undefined);
  if (state?.ok) return <p className="text-sm text-accent font-medium" role="status">✓ {state.ok}</p>;
  return (
    <div className="space-y-2">
      <form action={action} className="grid grid-cols-2 sm:grid-cols-[9rem_7rem_9rem_1fr_auto] gap-2 items-end">
        <input type="hidden" name="issueId" value={issueId} />
        <div>
          <label className="label" htmlFor={`d-${issueId}`}>Date</label>
          <input id={`d-${issueId}`} name="date" type="date" required defaultValue={guess.date} className="input mt-1" />
        </div>
        <div>
          <label className="label" htmlFor={`t-${issueId}`}>Money</label>
          <select id={`t-${issueId}`} name="direction" defaultValue="out" className="input mt-1">
            <option value="out">Out</option>
            <option value="in">In</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`a-${issueId}`}>Amount ₦</label>
          <input id={`a-${issueId}`} name="amount" inputMode="decimal" required defaultValue={guess.amount} className="input mt-1" />
        </div>
        <div className="col-span-2 sm:col-span-1">
          <label className="label" htmlFor={`n-${issueId}`}>Description</label>
          <input id={`n-${issueId}`} name="description" defaultValue={guess.description} maxLength={200} className="input mt-1" />
        </div>
        <button className="btn btn-primary h-10" disabled={pending}>{pending ? "Adding" : "Add to ledger"}</button>
      </form>
      <div className="flex items-center gap-3">
        <form action={ignoreIssueAction}>
          <input type="hidden" name="issueId" value={issueId} />
          <button className="btn btn-ghost h-8 px-2 text-sm">Not a transaction</button>
        </form>
        {state?.error && <p className="text-sm text-danger" role="alert">{state.error}</p>}
      </div>
    </div>
  );
}
