import Link from "next/link";
import { largest, monthPeriod, monthlyTrend, recurring, spendingByCategory, summary, topMerchants } from "@/core/analytics";
import { requireUser } from "@/lib/auth";
import { CategoryBars, MonthlyBars } from "@/components/charts";
import { MonthSwitcher, resolveOffset } from "@/components/month-switcher";
import { Card, Empty, Money, PageHeader, Stat, lagosDateLabel } from "@/components/ui";

export default async function Spending({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const offset = await resolveOffset(user.id, (await searchParams).m);
  const now = new Date();
  const p = monthPeriod(now, offset);
  const prev = monthPeriod(now, offset - 1);
  const [s, sPrev, cats, merchants, big, bills, trend] = await Promise.all([
    summary(user.id, p), summary(user.id, prev), spendingByCategory(user.id, p), topMerchants(user.id, p),
    largest(user.id, p, "DEBIT", 8), recurring(user.id, now, "DEBIT"), monthlyTrend(user.id, now, 6),
  ]);
  const delta = s.expenses - sPrev.expenses;
  const monthlyBills = bills.reduce((t, b) => t + b.averageMinor, 0n);

  return (
    <>
      <PageHeader title="Spending" subtitle="Own-account transfers are excluded from spending." action={<MonthSwitcher offset={offset} basePath="/app/spending" />} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Stat label={`Spent in ${p.label}`} minor={s.expenses} emphasis hint={`${s.expenseCount} debits`} />
        <Stat label={`vs ${prev.label}`} minor={delta} hint={delta > 0n ? "More than previous month" : delta < 0n ? "Less than previous month" : "Same as previous month"} />
        <Stat label="Recurring per month" minor={monthlyBills} hint={`${bills.length} recurring payments`} />
      </div>
      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <Card title="By category">
          {cats.length ? (
            <CategoryBars data={cats.map((c) => ({ label: c.category, value: c.total, count: c.count }))} total={s.expenses} />
          ) : <Empty>No spending in {p.label}.</Empty>}
        </Card>
        <Card title="Top merchants and people">
          {merchants.length ? (
            <ul className="divide-y divide-border">
              {merchants.map((m) => (
                <li key={m.merchant} className="flex justify-between py-2.5 text-sm gap-3">
                  <Link href={`/app/transactions?merchant=${encodeURIComponent(m.merchant)}`} className="truncate hover:underline">{m.merchant}</Link>
                  <span className="shrink-0 text-ink-2"><Money minor={m.total} /> <span className="text-ink-3 text-xs">· {m.count}</span></span>
                </li>
              ))}
            </ul>
          ) : <Empty>No merchants yet.</Empty>}
        </Card>
      </div>
      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <Card title="Spending trend">
          <MonthlyBars data={trend} />
        </Card>
        <Card title="Recurring payments">
          {bills.length ? (
            <ul className="divide-y divide-border">
              {bills.map((b) => (
                <li key={b.key} className="flex justify-between py-2.5 text-sm gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{b.name}</div>
                    <div className="text-xs text-ink-3">{b.category} · seen {b.occurrences}x · next ~{lagosDateLabel(b.nextExpected, { day: "numeric", month: "short" })}</div>
                  </div>
                  <Money minor={b.averageMinor} className="shrink-0" />
                </li>
              ))}
            </ul>
          ) : <Empty>Recurring detection needs at least 2 months of history.</Empty>}
        </Card>
      </div>
      <Card title="Largest expenses" className="mt-4">
        {big.length ? (
          <ul className="divide-y divide-border">
            {big.map((t) => (
              <li key={t.id} className="flex justify-between py-2.5 text-sm gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{t.merchantName ?? t.counterparty ?? t.description}</div>
                  <div className="text-xs text-ink-3">{lagosDateLabel(t.transactionDate)} · {t.category}</div>
                </div>
                <Money minor={t.amountMinor} className="shrink-0" />
              </li>
            ))}
          </ul>
        ) : <Empty>No expenses in {p.label}.</Empty>}
      </Card>
    </>
  );
}
