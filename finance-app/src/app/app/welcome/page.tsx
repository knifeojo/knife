import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { onboardingState, RELATIONSHIP_STATUSES, TRUST_NOTE } from "@/core/onboarding";
import { Card, PageHeader } from "@/components/ui";
import { saveOnboardingAction } from "../actions";

export default async function Welcome() {
  const user = await requireUser();
  const state = await onboardingState(user.id);
  if (!state.needsOnboarding) redirect("/app");

  return (
    <div className="max-w-xl">
      <PageHeader title="Who are your people?" subtitle="A few names so Ledger can label their payments from the first statement. Skip any you would rather not say." />
      <Card>
        <form action={saveOnboardingAction} className="space-y-4">
          {!state.ownName && (
            <div>
              <label className="label" htmlFor="ownName">Your full name</label>
              <input id="ownName" name="ownName" maxLength={80} placeholder="As your bank writes it" className="input mt-1" />
            </div>
          )}
          <div>
            <p className="label">Relationship status</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {RELATIONSHIP_STATUSES.map((s) => (
                <label key={s.value} className="inline-flex items-center gap-1.5 text-sm">
                  <input type="radio" name="relationshipStatus" value={s.value} className="accent-current" />
                  {s.label}
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="label" htmlFor="partner">Partner (spouse, fiancé(e), girlfriend/boyfriend)</label>
            <input id="partner" name="partner" maxLength={120} placeholder="One or more names" className="input mt-1" />
          </div>
          <div>
            <label className="label" htmlFor="parents">Parents</label>
            <input id="parents" name="parents" maxLength={200} placeholder="Comma-separated names" className="input mt-1" />
          </div>
          <div>
            <label className="label" htmlFor="siblings">Siblings</label>
            <input id="siblings" name="siblings" maxLength={200} placeholder="Comma-separated names" className="input mt-1" />
          </div>
          <div>
            <label className="label" htmlFor="supported">Anyone you support regularly</label>
            <input id="supported" name="supported" maxLength={200} placeholder="Aunts, uncles, others - labelled Family / Black tax" className="input mt-1" />
          </div>
          <p className="text-xs text-ink-3">{TRUST_NOTE}</p>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary h-10">Save</button>
            <button name="skip" value="1" className="btn btn-ghost h-10">Skip for now</button>
          </div>
        </form>
      </Card>
    </div>
  );
}
