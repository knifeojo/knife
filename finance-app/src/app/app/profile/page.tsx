import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { buildProfile } from "@/core/profile";
import { Card, Empty, PageHeader } from "@/components/ui";

export default async function ProfilePage() {
  const user = await requireUser();
  const p = await buildProfile(user.id);
  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader title="What Ledger knows about you" subtitle="Learned from your statements and your answers. The AI uses this as context. Change anything wrong in Review or Transactions." />
      <div className="grid sm:grid-cols-3 gap-4">
        <Card title="Average month">
          {p.monthly ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-ink-2">Income</dt><dd className="num text-credit">{p.monthly.income}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-2">Spending</dt><dd className="num">{p.monthly.spending}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-2">Net</dt><dd className="num font-medium">{p.monthly.net}</dd></div>
            </dl>
          ) : <Empty>No data yet.</Empty>}
          <p className="text-xs text-ink-3 mt-2">Based on {p.monthsOfData} month{p.monthsOfData === 1 ? "" : "s"} of data.</p>
        </Card>
        <Card title="You" className="sm:col-span-2">
          <p className="text-sm">{p.holderNames.join(", ") || "Name not detected yet"}</p>
          <ul className="mt-2 text-sm text-ink-2 space-y-1">
            {p.accounts.map((a) => <li key={a.name} className="flex justify-between gap-3"><span>{a.name}</span><span className="num">{a.balance}</span></li>)}
          </ul>
        </Card>
      </div>
      <Card title="Who pays you">
        {p.incomeSources.length ? (
          <ul className="divide-y divide-border text-sm">
            {p.incomeSources.map((s) => (
              <li key={s.name} className="flex justify-between gap-3 py-2">
                <span className="min-w-0"><span className="font-medium">{s.name}</span> <span className="text-ink-3">· {s.kind} · {s.payments} payment{s.payments > 1 ? "s" : ""}{s.typicalDay ? ` · usually around day ${s.typicalDay}` : ""}</span></span>
                <span className="num text-credit shrink-0">{s.total}</span>
              </li>
            ))}
          </ul>
        ) : <Empty>No income yet.</Empty>}
      </Card>
      <Card title="People and payees you have told us about" action={<Link href="/app/review" className="text-sm text-accent">Answer more</Link>}>
        {p.people.length ? (
          <ul className="grid sm:grid-cols-2 gap-x-6 text-sm">
            {p.people.map((x) => <li key={x.name} className="flex justify-between gap-3 border-b border-border py-1.5"><span className="truncate">{x.name}</span><span className="text-ink-2 truncate">{x.label}</span></li>)}
          </ul>
        ) : <Empty>Answer a few questions in Review and they will show here.</Empty>}
      </Card>
      <Card title="Regular payments">
        {p.commitments.length ? (
          <ul className="divide-y divide-border text-sm">
            {p.commitments.map((c) => <li key={c.name} className="flex justify-between gap-3 py-2"><span>{c.name} <span className="text-ink-3">· {c.category} · next around {c.nextAround}</span></span><span className="num">{c.amount}</span></li>)}
          </ul>
        ) : <Empty>Regular payments appear after two months of history.</Empty>}
      </Card>
    </div>
  );
}
