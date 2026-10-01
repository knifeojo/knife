import { incomeBySubcategory, incomeSources, largest, monthPeriod, recurring, summary } from "@/core/analytics";
import { requireUser } from "@/lib/auth";
import { CategoryBars } from "@/components/charts";
import { MonthSwitcher, resolveOffset } from "@/components/month-switcher";
import { Card, Empty, Money, PageHeader, Stat, lagosDateLabel } from "@/components/ui";
import { TxTable } from "@/components/tx-table";

export default async function Income({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const offset = await resolveOffset(user.id, (await searchParams).m);
  const now = new Date();
  const p = monthPeriod(now, offset);
  const [s, subs, credits, rec, sources] = await Promise.all([
    summary(user.id, p), incomeBySubcategory(user.id, p), largest(user.id, p, "CREDIT", 20), recurring(user.id, now, "CREDIT"), incomeSources(user.id, p, 10),
  ]);
  return (
    <>
      <PageHeader title="Income" subtitle="Change a category on any credit to correct how it is classified." action={<MonthSwitcher offset={offset} basePath="/app/income" />} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Stat
          label={`Received in ${p.label}`}
          minor={s.income}
          emphasis
          hint={`${s.incomeCount} credits${s.ratesUsed.length ? ` · ${s.ratesUsed.map((r) => `${r.currency} converted at your own rate (₦${r.rate.toFixed(0)}, from ${r.conversions} of your conversions)`).join(", ")}` : ""}`}
        />
        {subs.slice(0, 2).map((x) => <Stat key={x.subcategory} label={x.subcategory} minor={x.total} hint={`${x.count} payments`} />)}
      </div>
      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <Card title="Income by type">
          {subs.length ? <CategoryBars data={subs.map((x) => ({ label: x.subcategory, value: x.total, count: x.count }))} total={s.income} /> : <Empty>No income in {p.label}.</Empty>}
        </Card>
        <Card title="Who paid you">
          {sources.length ? (
            <CategoryBars data={sources.map((x) => ({ label: `${x.name} · ${x.kind}`, value: x.total, count: x.count }))} total={s.income} />
          ) : <Empty>No income in {p.label}.</Empty>}
        </Card>
        <Card title="Recurring income">
          {rec.length ? (
            <ul className="divide-y divide-border">
              {rec.map((r) => (
                <li key={r.key} className="flex justify-between py-2.5 text-sm gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{r.name}</div>
                    <div className="text-xs text-ink-3">{r.months} months · next ~{lagosDateLabel(r.nextExpected, { day: "numeric", month: "short" })}</div>
                  </div>
                  <Money minor={r.averageMinor} className="shrink-0" />
                </li>
              ))}
            </ul>
          ) : <Empty>Needs at least 2 months of history.</Empty>}
        </Card>
      </div>
      <Card title="Incoming payments" className="mt-4">
        {credits.length ? <TxTable rows={credits} /> : <Empty>No credits in {p.label}.</Empty>}
      </Card>
    </>
  );
}
