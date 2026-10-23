import Link from "next/link";
import { largest, monthPeriod, monthlyTrend, recurring, spendingByCategory, summary, topMerchants } from "@/core/analytics";
import { everydayReviewQuestions, loadCadence, spendingSplit } from "@/core/cadence";
import { EverydayBreakdownView, EverydayReviewCta, everydayHref } from "@/components/everyday";
import { requireUser } from "@/lib/auth";
import { formatMoney } from "@/lib/money";
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
  const cadence = await loadCadence(user.id, now);
  const split = await spendingSplit(user.id, p, cadence);
  const reviewQuestions = user.isDemo ? 0 : await everydayReviewQuestions(user.id, split.everyday);
  const short = (m: bigint) => formatMoney(m, "NGN", { compact: true });
  const catNote = (category: string) => {
    const g = split.byCategory.get(category);
    if (!g) return undefined;
    const parts = [g.recurringMinor > 0n && `${short(g.recurringMinor)} recurring`, g.oneOffMinor > 0n && `${short(g.oneOffMinor)} one-off`].filter(Boolean);
    return parts.length ? parts.join(" · ") : undefined;
  };
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
      <Card title="Recurring vs one-off" className="mt-4" action={<Link href="/app/afford" className="text-sm text-brand">Can I afford it?</Link>}>
        {!split.labelled ? (
          <Empty>Ledger only labels the last 6 months, the window it uses to find regular payments.</Empty>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { label: "Recurring bills", minor: split.recurringBillsMinor, hint: "Rent, family support, loan instalments, utilities, subscriptions", href: "/app/transactions?cadence=recurring" },
                { label: "Other regular payments", minor: split.recurringOtherMinor, hint: "Seen about monthly, but not a bill", href: "/app/transactions?cadence=recurring" },
                { label: "One-off spends", minor: split.oneOffMinor, hint: `Single payments from ${formatMoney(split.oneOffMinMinor).replace(/\.00$/, "")}`, href: "/app/transactions?cadence=one_off" },
                { label: "Everyday spending", minor: split.everydayMinor, hint: "Everything else: see what it was", href: everydayHref(p) },
              ].map((x) => (
                <div key={x.label} className="rounded-xl bg-surface-2 p-3">
                  <div className="text-xs text-ink-3">{x.href ? <Link href={x.href} className="hover:underline">{x.label}</Link> : x.label}</div>
                  <div className="num font-semibold mt-1">{short(x.minor)}</div>
                  <div className="text-xs text-ink-3 mt-0.5">{x.hint}</div>
                </div>
              ))}
            </div>
            {split.oneOffs.length > 0 && (
              <ul className="divide-y divide-border mt-3">
                {split.oneOffs.map((o) => (
                  <li key={o.id} className="flex justify-between py-2 text-sm gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{o.name}</div>
                      <div className="text-xs text-ink-3">{lagosDateLabel(o.date)} · {o.category}{o.subcategory ? ` · ${o.subcategory}` : ""} · one-off</div>
                    </div>
                    <Money minor={o.amountMinor} className="shrink-0" />
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-ink-3 mt-3">Same rules as Can I afford it?: a payment is recurring when it shows up about once a month for 2 months or more. One-offs are already in your spending; they are not counted as bills.</p>
          </>
        )}
      </Card>
      {split.labelled && (
        <Card
          title={`Everyday spending: ${short(split.everyday.totalMinor)}`}
          className="mt-4"
          action={<Link href={everydayHref(p)} className="text-sm text-brand">See {split.everyday.count} transactions</Link>}
        >
          <div id="everyday" className="space-y-4">
            <EverydayReviewCta everyday={split.everyday} reviewQuestions={reviewQuestions} period={p} />
            <EverydayBreakdownView everyday={split.everyday} period={p} />
          </div>
        </Card>
      )}
      <div className="grid lg:grid-cols-2 gap-4 mt-4">
        <Card title="By category">
          {cats.length ? (
            <CategoryBars data={cats.map((c) => ({ label: c.category, value: c.total, count: c.count, note: catNote(c.category) }))} total={s.expenses} />
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
                    <div className="text-xs text-ink-3">{b.category}{cadence.recurring.get(b.transactionIds[0])?.bill ? " · bill" : ""} · seen {b.occurrences}x · next ~{lagosDateLabel(b.nextExpected, { day: "numeric", month: "short" })}</div>
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
