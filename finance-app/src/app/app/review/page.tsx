import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { reviewWithSuggestions, type SuggestionGroup } from "@/core/ai/suggestions";
import { ALL_CATEGORIES } from "@/core/categorize";
import { formatMoney } from "@/lib/money";
import { Card, PageHeader } from "@/components/ui";
import { answerQuestionAction, confirmSuggestionAction, dismissGapAction, dismissReconAction, dismissSuggestionAction, resolveUnparsedAction, unlockStatementAction } from "../actions";
import { onboardingState } from "@/core/onboarding";
import { db } from "@/lib/db";
import { TopPeopleCard } from "../top-people";
import { PersonAnswers, PersonStatsLine } from "./person-answers";

const labelOf = (g: SuggestionGroup) => (g.subcategory ? `${g.category} / ${g.subcategory}` : g.category);

/** The AI's pick, pre-selected: one tap confirms it and saves it as a rule for this payee. */
function AiPick({ g }: { g: SuggestionGroup }) {
  return (
    <div className="mt-3 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2.5" data-testid="ai-pick">
      <p className="text-xs text-accent font-medium">Suggested by AI ({g.model}) · {Math.round(g.confidence * 100)}% sure</p>
      <p className="text-sm mt-0.5"><span className="font-semibold">{labelOf(g)}</span>{g.reason ? <span className="text-ink-2"> · {g.reason}</span> : null}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <form action={confirmSuggestionAction}>
          <input type="hidden" name="id" value={g.id} />
          <button className="btn btn-primary h-9 text-sm">Confirm {labelOf(g)}</button>
        </form>
        <form action={dismissSuggestionAction}>
          <input type="hidden" name="id" value={g.id} />
          <button className="btn btn-ghost h-9 px-2 text-sm">Not right</button>
        </form>
      </div>
    </div>
  );
}

export default async function Review({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const [{ questions, suggestions }, welcome, unparsed, gaps, flags, locked] = await Promise.all([
    reviewWithSuggestions(user.id),
    onboardingState(user.id),
    db.unparsedAlert.findMany({ where: { userId: user.id, status: "open" }, orderBy: { receivedAt: "desc" }, take: 40 }),
    db.balanceGap.findMany({ where: { userId: user.id, status: "open" }, orderBy: { atDate: "desc" }, take: 20 }),
    db.reconFlag.findMany({ where: { userId: user.id, status: "open" }, orderBy: { createdAt: "desc" }, take: 20 }),
    db.statementFile.findMany({
      where: { userId: user.id, status: "needs_password" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, fileName: true, institution: true, sender: true, subject: true, detail: true, bytesStored: true },
    }),
  ]);
  const lockedFiles = locked.map((file) => ({
    id: file.id,
    fileName: file.fileName,
    institution: file.institution,
    sender: file.sender,
    subject: file.subject,
    detail: file.detail,
    hasBytes: file.bytesStored,
  }));
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
      {sp.statement === "ok" && <p className="mb-4 rounded-xl bg-accent-soft text-accent px-4 py-3 text-sm">Statement imported. The password was not sent anywhere except this machine.</p>}
      {sp.statement === "wrong" && <p className="mb-4 rounded-xl bg-warn-bg text-warn-ink px-4 py-3 text-sm">That password did not open the statement. It stays in Review. Nothing was sent to the cloud AI.</p>}
      <p className="-mt-2 mb-4 text-sm text-ink-2">
        People come first: tell Ledger who someone is once and every payment to and from them is labelled. See and change them on{" "}
        <Link href="/app/people" className="text-accent underline">Your people</Link>.
      </p>
      {welcome.topPeople.show && <TopPeopleCard people={welcome.topPeople.people} />}
      {lockedFiles.length > 0 && (
        <Card title="Statements that need a password" className="mb-4">
          <p className="text-sm text-ink-2 mb-3">The PDF password from the bank&rsquo;s email, not your bank login. Typed here once, used only to open the file on this machine, never sent to the cloud AI.</p>
          <ul className="space-y-4">
            {lockedFiles.map((file) => (
              <li key={file.id} className="text-sm border-t border-border pt-3 first:border-0 first:pt-0">
                <p className="font-medium">{file.fileName}</p>
                <p className="text-xs text-ink-3">{file.institution ?? "Unknown bank"}{file.sender ? ` · ${file.sender}` : ""}{file.subject ? ` · ${file.subject}` : ""}</p>
                {file.hasBytes ? (
                  <form action={unlockStatementAction} className="mt-2 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="id" value={file.id} />
                    <div>
                      <label className="label" htmlFor={`stmt-pw-${file.id}`}>Password</label>
                      <input id={`stmt-pw-${file.id}`} name="password" type="password" autoComplete="off" required className="input mt-1" />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-ink-2 mb-2">
                      <input type="checkbox" name="remember" value="1" />
                      Remember for {file.institution ?? "this bank"}
                    </label>
                    <button className="btn btn-secondary h-9 text-sm">Open statement</button>
                  </form>
                ) : (
                  <p className="mt-2 text-xs text-warn-ink">{file.detail ?? "The file could not be kept. Upload it on Accounts and enter the password there."}</p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {unparsed.length > 0 && (
        <Card title="Unparsed bank alerts" className="mb-4">
          <p className="text-sm text-ink-2 mb-3">Known bank senders we could not post automatically. Samples stay on this machine only.</p>
          <ul className="space-y-3">
            {unparsed.map((u) => (
              <li key={u.id} className="text-sm border-t border-border pt-3 first:border-0 first:pt-0">
                <p className="text-xs text-ink-3">{u.channel} · {u.sender} · {u.reason}{u.parser ? ` · ${u.parser}` : ""}</p>
                <pre className="mt-1 text-xs font-mono whitespace-pre-wrap break-words bg-surface-2 rounded px-2 py-1">{u.rawText}</pre>
                <div className="mt-2 flex gap-2">
                  <form action={resolveUnparsedAction}>
                    <input type="hidden" name="id" value={u.id} />
                    <input type="hidden" name="action" value="add" />
                    <button className="btn btn-secondary h-8 text-xs">Try to add</button>
                  </form>
                  <form action={resolveUnparsedAction}>
                    <input type="hidden" name="id" value={u.id} />
                    <input type="hidden" name="action" value="ignore" />
                    <button className="btn btn-ghost h-8 text-xs">Ignore</button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {gaps.length > 0 && (
        <Card title="Possible missed transactions" className="mb-4">
          <p className="text-sm text-ink-2 mb-3">The running balance on an alert does not follow from the previous one.</p>
          <ul className="space-y-2 text-sm">
            {gaps.map((g) => (
              <li key={g.id} className="flex justify-between gap-3">
                <span>Gap of {formatMoney(g.gapMinor)} on {g.atDate.toLocaleDateString("en-GB")}</span>
                <form action={dismissGapAction}><input type="hidden" name="id" value={g.id} /><button className="btn btn-ghost h-8 text-xs">Dismiss</button></form>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {flags.length > 0 && (
        <Card title="Alert vs statement" className="mb-4">
          <ul className="space-y-2 text-sm">
            {flags.map((f) => (
              <li key={f.id} className="flex justify-between gap-3">
                <span>{f.kind === "alert_without_statement" ? "Alert with no statement row" : "Statement row with no alert"} — {f.detail}</span>
                <form action={dismissReconAction}><input type="hidden" name="id" value={f.id} /><button className="btn btn-ghost h-8 text-xs">Dismiss</button></form>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {!questions.length && !suggestions.length && !unparsed.length && !gaps.length && !flags.length && !lockedFiles.length && (
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
                  <PersonStatsLine q={q} />
                </div>
                {q.totalMinor > 0n && (
                  <div className="text-right shrink-0">
                    <div className="num font-semibold">{formatMoney(q.totalMinor, q.totalCurrency ?? "NGN")}</div>
                    {q.totalDetail && <div className="text-xs text-ink-3" title={q.totalDetail}>{q.totalDetail}</div>}
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
              {q.aiSuggestion && !(q.person && q.aiRelationship) && <AiPick g={q.aiSuggestion} />}
              {q.person ? <PersonAnswers q={q} /> : <>
              <div className="mt-4 flex flex-wrap gap-2">
                {q.options.map((o, k) => (
                  <form key={o.value} action={answerQuestionAction}>
                    <input type="hidden" name="kind" value={q.kind} />
                    <input type="hidden" name="key" value={q.key} />
                    <input type="hidden" name="value" value={o.value} />
                    <button className={`btn h-9 text-sm ${k === 0 && o.value === "hint" && !q.aiSuggestion ? "btn-primary" : "btn-secondary"}`}>{o.label}</button>
                  </form>
                ))}
              </div>
              {q.kind !== "holder" && q.kind !== "conversion" && q.kind !== "mispair" && q.kind !== "duplicate" && q.kind !== "currency" && q.kind !== "advance" && (
                <form action={answerQuestionAction} className="mt-2">
                  <input type="hidden" name="kind" value={q.kind} />
                  <input type="hidden" name="key" value={q.key} />
                  <input type="hidden" name="value" value="unknown" />
                  <button className="btn btn-ghost h-8 px-2 text-sm">Can&rsquo;t remember</button>
                </form>
              )}
              {q.kind !== "holder" && q.kind !== "conversion" && q.kind !== "mispair" && q.kind !== "duplicate" && q.kind !== "currency" && q.kind !== "advance" && (
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
              </>}
            </Card>
          </li>
        ))}
      </ol>
      {suggestions.length > 0 && (
        <section className="mt-8">
          <h2 className="font-semibold">Suggested by AI</h2>
          <p className="text-sm text-ink-2 mt-1">Payments the rules could not label. Nothing changes until you confirm; confirming also labels future payments to the same payee.</p>
          <ul className="mt-3 space-y-3">
            {suggestions.map((g) => (
              <li key={g.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-medium truncate">{g.display}</h3>
                      <p className="text-xs text-ink-3">{g.type === "CREDIT" ? "Money in" : "Money out"} · now &ldquo;{g.currentCategory}&rdquo;</p>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="num font-semibold">{formatMoney(g.totalMinor)}</div>
                      <div className="text-xs text-ink-3">{g.count} payment{g.count > 1 ? "s" : ""}</div>
                    </div>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {g.examples.map((e, k) => <li key={k} className="text-xs text-ink-2 font-mono break-words whitespace-pre-wrap rounded bg-surface-2 px-2 py-1">{e}</li>)}
                  </ul>
                  <AiPick g={g} />
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
