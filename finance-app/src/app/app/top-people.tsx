import { RELATIONSHIP_OPTIONS } from "@/core/review";
import { TRUST_NOTE } from "@/core/onboarding";
import type { TopPerson } from "@/core/review";
import { formatMoney } from "@/lib/money";
import { Card } from "@/components/ui";
import { answerQuestionAction, finishTopPeopleAction } from "./actions";

const PICKS = RELATIONSHIP_OPTIONS.filter((o) => !["rel:vendor", "rel:other", "rel:me", "rel:colleague"].includes(o.value));

/** After the first upload: one-tap who the people you send the most money to are. */
export function TopPeopleCard({ people }: { people: TopPerson[] }) {
  if (!people.length) return null;
  return (
    <Card className="mb-4" data-testid="top-people">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">You send money to these people most. Who are they?</h2>
          <p className="text-sm text-ink-2 mt-1">One tap each. Your answer labels every payment with them, past and future.</p>
        </div>
        <form action={finishTopPeopleAction}>
          <button className="btn btn-ghost h-8 px-2 text-sm">Done</button>
        </form>
      </div>
      <ul className="mt-4 space-y-4">
        {people.map((p) => (
          <li key={p.key} className="border-t border-border pt-3" data-testid={`top-person-${p.key}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-medium">{p.display}</p>
              <p className="text-xs text-ink-3 num">
                Sent {p.person.outCount}× · {formatMoney(p.person.outMinor)}
                {p.person.inCount > 0 && <> · received {p.person.inCount}×</>}
              </p>
            </div>
            {p.guess && (
              <p className="mt-1 text-xs text-accent font-medium" data-testid={`guess-${p.key}`}>{p.guess.reason}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {(p.guess?.answers ?? PICKS).map((a) => (
                <form key={`${a.value}:${a.label}`} action={answerQuestionAction}>
                  <input type="hidden" name="kind" value="person" />
                  <input type="hidden" name="key" value={p.key} />
                  <input type="hidden" name="value" value={a.value} />
                  {"vendorCategory" in a && a.vendorCategory && <input type="hidden" name="vendorCategory" value={a.vendorCategory} />}
                  {"vendorSubcategory" in a && a.vendorSubcategory && <input type="hidden" name="vendorSubcategory" value={a.vendorSubcategory} />}
                  <button className="btn btn-secondary h-9 text-sm">{a.label}</button>
                </form>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-3">{TRUST_NOTE}</p>
    </Card>
  );
}
