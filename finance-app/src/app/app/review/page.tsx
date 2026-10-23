import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { buildQuestions } from "@/core/review";
import { ALL_CATEGORIES } from "@/core/categorize";
import { formatMoney } from "@/lib/money";
import { Card, PageHeader } from "@/components/ui";
import { answerQuestionAction } from "../actions";

export default async function Review() {
  const user = await requireUser();
  const questions = await buildQuestions(user.id);
  const total = questions.reduce((s, q) => s + q.totalMinor, 0n);

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Help Ledger get this right"
        subtitle={
          questions.length
            ? `${questions.length} quick questions. Your answers label ${formatMoney(total, "NGN", { compact: true })} of transactions and every future payment to the same names.`
            : "Nothing to ask right now. New questions appear when new names show up in your transactions."
        }
      />
      {!questions.length && (
        <Card>
          <p className="text-sm text-ink-2">All caught up. You can still change any category on the <Link href="/app/transactions" className="text-accent underline">Transactions</Link> page.</p>
        </Card>
      )}
      <ol className="space-y-4">
        {questions.map((q, i) => (
          <li key={`${q.kind}:${q.key}`}>
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs text-ink-3 num">Question {i + 1} of {questions.length}</p>
                  <h2 className="font-semibold mt-1">{q.title}</h2>
                  <p className="text-sm text-ink-2 mt-1">{q.prompt}</p>
                  {q.hint && <p className="text-xs mt-2 inline-flex rounded-full bg-accent-soft text-accent px-2 py-0.5">{q.hint}</p>}
                </div>
                {q.totalMinor > 0n && (
                  <div className="text-right shrink-0">
                    <div className="num font-semibold">{formatMoney(q.totalMinor)}</div>
                    <div className="text-xs text-ink-3">{q.count} payment{q.count > 1 ? "s" : ""}{q.currentCategory ? ` · now "${q.currentCategory}"` : ""}</div>
                  </div>
                )}
              </div>
              {q.evidence && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-sm num min-w-[360px]">
                    <thead><tr className="text-left text-xs text-ink-3"><th className="font-normal py-1">Date</th><th className="font-normal text-right">Sent from your other account</th><th className="font-normal text-right">Arrived here</th></tr></thead>
                    <tbody>{q.evidence.map((e, k) => <tr key={k} className="border-t border-border"><td className="py-1.5">{e.date}</td><td className="text-right">{e.sent}</td><td className="text-right">{e.received}</td></tr>)}</tbody>
                  </table>
                </div>
              )}
              {q.narrationHints && q.narrationHints.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-ink-3">From the narration:</span>
                  {q.narrationHints.map((h) => (
                    <form key={h.words} action={answerQuestionAction}>
                      <input type="hidden" name="kind" value={q.kind} />
                      <input type="hidden" name="key" value={q.key} />
                      <input type="hidden" name="value" value="other" />
                      <input type="hidden" name="otherText" value={h.words} />
                      <input type="hidden" name="otherCategory" value={h.category === "Other" ? "" : h.category} />
                      <button className="inline-flex rounded-full bg-accent-soft text-accent px-2.5 py-0.5 text-xs font-medium hover:opacity-90" title="Use this as the answer">
                        &ldquo;{h.words.toUpperCase()}&rdquo;{h.category !== "Other" ? ` → ${h.category}` : ""}
                      </button>
                    </form>
                  ))}
                </div>
              )}
              {q.examples.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs text-ink-3">{q.examples.length === 1 ? "What your bank wrote" : `What your bank wrote (${q.examples.length} of ${q.count})`}</p>
                  <ul className="mt-1 space-y-1">
                    {q.examples.map((e, k) => <li key={k} className="text-xs text-ink-2 font-mono break-words whitespace-pre-wrap rounded bg-surface-2 px-2 py-1">{e}</li>)}
                  </ul>
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                {q.options.map((o, k) => (
                  <form key={o.value} action={answerQuestionAction}>
                    <input type="hidden" name="kind" value={q.kind} />
                    <input type="hidden" name="key" value={q.key} />
                    <input type="hidden" name="value" value={o.value} />
                    <button className={`btn h-9 text-sm ${k === 0 && o.value === "hint" ? "btn-primary" : "btn-secondary"}`}>{o.label}</button>
                  </form>
                ))}
              </div>
              {q.kind !== "holder" && q.kind !== "conversion" && (
                <form action={answerQuestionAction} className="mt-2">
                  <input type="hidden" name="kind" value={q.kind} />
                  <input type="hidden" name="key" value={q.key} />
                  <input type="hidden" name="value" value="unknown" />
                  <button className="btn btn-ghost h-8 px-2 text-sm">Can&rsquo;t remember</button>
                </form>
              )}
              {q.kind !== "holder" && q.kind !== "conversion" && (
                <details className="mt-3 group">
                  <summary className="cursor-pointer text-sm text-accent font-medium list-none">Other… type your own answer</summary>
                  <form action={answerQuestionAction} className="mt-3 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="kind" value={q.kind} />
                    <input type="hidden" name="key" value={q.key} />
                    <input type="hidden" name="value" value="other" />
                    <div className="flex-1 min-w-48">
                      <label className="label" htmlFor={`t-${i}`}>{q.kind === "income" ? "What is this money?" : "Who or what is this?"}</label>
                      <input
                        id={`t-${i}`}
                        name="otherText"
                        required
                        maxLength={60}
                        placeholder={q.kind === "income" ? "e.g. rent from my tenant, side gig, allowance" : "e.g. my landlady, my tailor, car loan, church"}
                        className="input mt-1"
                      />
                    </div>
                    <div>
                      <label className="label" htmlFor={`c-${i}`}>Category</label>
                      <select id={`c-${i}`} name="otherCategory" defaultValue="" className="input mt-1 w-48">
                        <option value="">Let Ledger decide</option>
                        {ALL_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                      </select>
                    </div>
                    <button className="btn btn-primary h-10">Save</button>
                  </form>
                  <p className="text-xs text-ink-3 mt-2">Your words become the label (e.g. Housing / &ldquo;My landlady&rdquo;) and apply to every payment with this name.</p>
                </details>
              )}
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}
