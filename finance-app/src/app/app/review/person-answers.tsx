import type { QuestionWithSuggestion } from "@/core/ai/suggestions";
import { ALL_CATEGORIES } from "@/core/categorize";
import type { Option } from "@/core/review";
import { formatMoney } from "@/lib/money";
import { answerQuestionAction } from "../actions";

function Answer({ q, o, primary, children }: { q: QuestionWithSuggestion; o: Option; primary?: boolean; children?: React.ReactNode }) {
  return (
    <form action={answerQuestionAction}>
      <input type="hidden" name="kind" value={q.kind} />
      <input type="hidden" name="key" value={q.key} />
      <input type="hidden" name="value" value={o.value} />
      <button className={`btn h-9 text-sm ${primary ? "btn-primary" : "btn-secondary"}`} data-testid={`answer-${o.value}`}>
        {children ?? o.label}
      </button>
    </form>
  );
}

/** Money both ways with one person, then the one-tap relationship answers. */
export function PersonStatsLine({ q }: { q: QuestionWithSuggestion }) {
  const p = q.person;
  if (!p) return null;
  return (
    <p className="mt-2 text-xs text-ink-3 num">
      {p.outCount > 0 && <>Sent {p.outCount}× · {formatMoney(p.outMinor)}</>}
      {p.outCount > 0 && p.inCount > 0 && " · "}
      {p.inCount > 0 && <>Received {p.inCount}× · {formatMoney(p.inMinor)}</>}
      {" · "}last {p.lastDate}
      {p.variants.length > 1 && <> · also written as {p.variants.filter((v) => v.toLowerCase() !== q.key).join(", ")}</>}
    </p>
  );
}

export function PersonAnswers({ q }: { q: QuestionWithSuggestion }) {
  const main = q.options.filter((o) => o.group === "relationship" && o.value !== "rel:vendor" && o.value !== "rel:other");
  const vendor = q.options.find((o) => o.value === "rel:vendor");
  const someone = q.options.find((o) => o.value === "rel:other");
  const more = q.options.filter((o) => o.group === "more");
  const control = q.options.filter((o) => o.group === "control");
  const ai = q.aiRelationship ? `rel:${q.aiRelationship}` : undefined;
  return (
    <>
      {ai && (
        <p className="mt-3 text-xs text-accent font-medium" data-testid="ai-relationship">
          AI thinks this is your {q.options.find((o) => o.value === ai)?.label.toLowerCase()}. Tap it to confirm.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {main.map((o) => <Answer key={o.value} q={q} o={o} primary={o.value === ai} />)}
      </div>
      {vendor && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-accent font-medium list-none">{vendor.label}…</summary>
          <form action={answerQuestionAction} className="mt-2 flex flex-wrap items-end gap-2">
            <input type="hidden" name="kind" value={q.kind} />
            <input type="hidden" name="key" value={q.key} />
            <input type="hidden" name="value" value="rel:vendor" />
            <div>
              <label className="label" htmlFor={`vc-${q.key}`}>What do you pay them for?</label>
              <select id={`vc-${q.key}`} name="vendorCategory" defaultValue="Shopping" className="input mt-1 w-44">
                {ALL_CATEGORIES.filter((c) => c !== "Income" && c !== "Own transfer").map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-40">
              <label className="label" htmlFor={`vs-${q.key}`}>Label (optional)</label>
              <input id={`vs-${q.key}`} name="vendorSubcategory" maxLength={40} placeholder="e.g. Tailor, Driver, Hair" className="input mt-1" />
            </div>
            <button className="btn btn-primary h-10">Save</button>
          </form>
        </details>
      )}
      {(someone || more.length > 0) && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-accent font-medium list-none">Someone else…</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {someone && <Answer q={q} o={someone}>Someone else (just remember them)</Answer>}
            {more.map((o) => <Answer key={o.value} q={q} o={o} />)}
          </div>
          <form action={answerQuestionAction} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="kind" value={q.kind} />
            <input type="hidden" name="key" value={q.key} />
            <input type="hidden" name="value" value="other" />
            <div className="flex-1 min-w-48">
              <label className="label" htmlFor={`pt-${q.key}`}>Or type who they are</label>
              <input id={`pt-${q.key}`} name="otherText" required maxLength={60} placeholder="e.g. my landlady, church, car loan" className="input mt-1" />
            </div>
            <button className="btn btn-secondary h-10">Save</button>
          </form>
        </details>
      )}
      <div className="mt-3 flex flex-wrap gap-1">
        {control.map((o) => (
          <form key={o.value} action={answerQuestionAction}>
            <input type="hidden" name="kind" value={q.kind} />
            <input type="hidden" name="key" value={q.key} />
            <input type="hidden" name="value" value={o.value} />
            <button className="btn btn-ghost h-8 px-2 text-sm">{o.label}</button>
          </form>
        ))}
      </div>
    </>
  );
}
