"use client";

import { useActionState, useState, useTransition } from "react";
import { applyNotesAction, matchNotesAction, type NotesState } from "@/app/app/actions";
import { formatMoney } from "@/lib/money";
import type { NoteMatch } from "@/core/notes";

const STATUS: Record<NoteMatch["status"], { text: string; tone: string }> = {
  matches: { text: "Found", tone: "text-credit" },
  close: { text: "Roughly found", tone: "text-credit" },
  "partly found": { text: "Partly found", tone: "text-warn-ink" },
  "bank shows more": { text: "Bank shows more", tone: "text-warn-ink" },
  "not in your statements": { text: "Not in your statements", tone: "text-ink-3" },
  "no amount": { text: "No amount", tone: "text-ink-3" },
};

const money = (minor?: bigint | string) => (minor === undefined ? "" : formatMoney(BigInt(minor)));

export function NotesForm() {
  const [state, action, pending] = useActionState<NotesState, FormData>(matchNotesAction, undefined);
  const [applying, startApply] = useTransition();
  const [applied, setApplied] = useState<number | undefined>();
  const results = state?.results ?? [];
  const found = results.filter((r) => r.matched.length);
  const missing = results.filter((r) => !r.matched.length && r.notedMinor !== undefined);

  const apply = (form: HTMLFormElement) => startApply(async () => setApplied(await applyNotesAction(new FormData(form))));

  return (
    <div className="space-y-4">
      <form action={(fd) => (setApplied(undefined), action(fd))} className="card p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="month" className="label">Month</label>
            <input id="month" name="month" type="month" className="input mt-1" />
          </div>
          <p className="text-xs text-ink-3 pb-2">Or start your notes with a heading like &ldquo;Expense Sept&rdquo;.</p>
        </div>
        <div>
          <label htmlFor="notes" className="label">Your notes</label>
          <textarea id="notes" name="notes" rows={10} className="input mt-1 font-mono text-sm" placeholder={"Expense Sept\nWife 750\nRent 500\nLoan\n    Rm 1.3\n    Fm 400"} />
          <p className="text-xs text-ink-3 mt-1">Rough is fine. &ldquo;750&rdquo; means ₦750K and &ldquo;1.3&rdquo; means ₦1.3M. Indent sub-items under a heading.</p>
        </div>
        <button className="btn btn-primary" disabled={pending}>{pending ? "Matching…" : "Match to my transactions"}</button>
        {state?.error && <p className="text-sm text-danger" role="alert">{state.error}</p>}
      </form>

      {results.length > 0 && (
        <form onSubmit={(e) => (e.preventDefault(), apply(e.currentTarget))} className="card p-4 space-y-3">
          <div>
            <h2 className="font-semibold">{state?.month}: {found.length} of {results.length} lines found in your statements</h2>
            <p className="text-sm text-ink-2">Tick the ones that are right and Ledger will label those payments with the purpose from your notes.</p>
          </div>
          <ul className="divide-y divide-border">
            {found.map((r, i) => {
              const ids = r.matched.filter((m) => !m.userLabelled).map((m) => m.id);
              const st = STATUS[r.status];
              return (
                <li key={i} className="py-3 flex gap-3">
                  <input
                    type="checkbox"
                    name="apply"
                    aria-label={`Label as ${r.proposal?.subcategory}`}
                    disabled={!ids.length || !r.proposal}
                    defaultChecked={!!ids.length && (r.status === "matches" || r.status === "close")}
                    value={JSON.stringify({ ids, ...r.proposal })}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className="font-medium">{r.path}{r.notedMinor !== undefined && <span className="text-ink-3 font-normal num"> · noted {money(r.notedMinor)}</span>}</span>
                      <span className={`text-sm ${st.tone}`}>{st.text} · <span className="num">{money(r.matchedMinor)}</span></span>
                    </div>
                    <p className="text-xs text-ink-3">Matched by {r.how}{ids.length && r.proposal ? `. Label: ${r.proposal.category} / ${r.proposal.subcategory}` : ""}</p>
                    <ul className="mt-1 text-sm text-ink-2 space-y-0.5">
                      {r.matched.map((m) => (
                        <li key={m.id} className="flex justify-between gap-3">
                          <span className="truncate">{m.date} · {m.description}</span>
                          <span className="shrink-0 num">{m.amount}{m.userLabelled && <span className="text-ink-3"> · kept your label &ldquo;{m.label}&rdquo;</span>}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" disabled={applying}>{applying ? "Labelling…" : "Label ticked payments"}</button>
            {applied !== undefined && <p className="text-sm text-credit" role="status">✓ {applied} payment{applied === 1 ? "" : "s"} labelled. Amounts unchanged.</p>}
          </div>
          {missing.length > 0 && (
            <div className="rounded-lg bg-surface-2 p-3 text-sm">
              <p className="font-medium">Not in your statements ({money(missing.reduce((s, r) => s + BigInt(r.notedMinor!), 0n))})</p>
              <p className="text-ink-2">Paid in cash, from another account, or described differently: {missing.map((r) => `${r.label} ${money(r.notedMinor)}`).join(", ")}. Upload that account&rsquo;s statement to bring them in. Nothing is added from notes alone.</p>
            </div>
          )}
        </form>
      )}
    </div>
  );
}
