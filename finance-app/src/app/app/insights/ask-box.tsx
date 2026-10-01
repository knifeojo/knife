"use client";

import { useRef, useState, useTransition } from "react";
import { chatAction, type ChatResult } from "../actions";

type Turn = { role: "user" | "assistant"; text: string; result?: ChatResult };

const TOOL_LABELS: Record<string, string> = {
  get_period_summary: "Income and spending for a period",
  spending_by_category: "Spending by category",
  income_sources: "Who paid you",
  find_transactions: "Searched your transactions",
  compare_periods: "Compared two periods",
  person_summary: "Everything with one person",
  recurring_payments: "Regular payments",
  balances: "Account balances",
  profile: "What Ledger knows about you",
};

export function AskBox({ suggestions, aiOn }: { suggestions: string[]; aiOn: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const send = (question: string) => {
    const q = question.trim();
    if (!q || pending) return;
    const history = turns.map((t) => ({ role: t.role, text: t.text }));
    setTurns((t) => [...t, { role: "user", text: q }]);
    if (inputRef.current) inputRef.current.value = "";
    start(async () => {
      const result = await chatAction(q, history);
      const text = "error" in result ? result.error : result.text;
      setTurns((t) => [...t, { role: "assistant", text, result }]);
    });
  };

  return (
    <div className="space-y-4">
      {turns.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <button key={s} type="button" onClick={() => send(s)} className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-2">
              {s}
            </button>
          ))}
        </div>
      )}

      <ol className="space-y-3" aria-live="polite">
        {turns.map((t, i) => (
          <li key={i} className={t.role === "user" ? "flex justify-end" : ""}>
            {t.role === "user" ? (
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-ink text-bg px-4 py-2 text-sm">{t.text}</p>
            ) : (
              <div className="card p-4 max-w-[95%] space-y-3">
                <p className="text-[15px] leading-relaxed whitespace-pre-line">{t.text}</p>
                {t.result && "mode" in t.result && t.result.mode === "ai" && (
                  <>
                    {!t.result.grounded && (
                      <p className="text-xs rounded-lg bg-warn-bg text-warn-ink px-2 py-1">Some figures here could not be traced to your ledger. Double-check them on the Transactions page.</p>
                    )}
                    {t.result.toolCalls.length > 0 && (
                      <details className="text-xs text-ink-3">
                        <summary className="cursor-pointer">How I worked this out ({t.result.toolCalls.length} lookup{t.result.toolCalls.length > 1 ? "s" : ""} in your ledger)</summary>
                        <ul className="mt-2 space-y-1">
                          {t.result.toolCalls.map((c, k) => (
                            <li key={k}>
                              <span className="font-medium text-ink-2">{TOOL_LABELS[c.tool] ?? c.tool}</span>
                              <pre className="mt-1 max-h-40 overflow-auto rounded bg-surface-2 p-2 text-[11px] whitespace-pre-wrap">{JSON.stringify(c.output, null, 1).slice(0, 1500)}</pre>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                )}
                {t.result && "mode" in t.result && t.result.mode === "rules" && t.result.facts.facts.length > 0 && (
                  <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
                    {t.result.facts.facts.map((f) => (
                      <div key={f.label} className="flex justify-between gap-3 border-b border-border py-1">
                        <dt className="text-ink-2 truncate">{f.label}</dt>
                        <dd className="num font-medium shrink-0">{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )}
          </li>
        ))}
        {pending && <li className="text-sm text-ink-3">Looking through your ledger…</li>}
      </ol>

      <form
        className="card p-2 flex gap-2 sticky bottom-4"
        onSubmit={(e) => {
          e.preventDefault();
          send(inputRef.current?.value ?? "");
        }}
      >
        <input
          ref={inputRef}
          placeholder={turns.length ? "Ask a follow-up…" : "Ask anything about your money"}
          className="flex-1 bg-transparent px-3 text-sm outline-none min-w-0"
          maxLength={400}
          aria-label="Your question"
        />
        <button className="btn btn-primary" disabled={pending}>Ask</button>
      </form>
      <p className="text-xs text-ink-3">
        {aiOn
          ? "AI assistant on. It looks things up in your ledger; every figure comes from your data, never from the AI's memory."
          : "Answering with built-in rules. Turn on AI in Settings for free-form questions and follow-ups."}
      </p>
    </div>
  );
}
