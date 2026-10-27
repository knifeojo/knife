import Link from "next/link";
import { largest, monthPeriod, monthlyTrendFor, spendingByCategory, summary } from "@/core/analytics";
import { reviewQuestionsFor, loadCadence, spendingSplit } from "@/core/cadence";
import { EverydayBreakdownView, PayeeList, ReviewCta, everydayHref, recurringKindLabel } from "@/components/everyday";
import { requireUser } from "@/lib/auth";
import { formatMoney } from "@/lib/money";
import { CategoryBars, MonthlyBars } from "@/components/charts";
import { PeriodSwitcher, resolveViewPeriod } from "@/components/period-switcher";
import { Card, Empty, Money, PageHeader, Stat, lagosDateLabel } from "@/components/ui";

export default async function Spending({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const now = new Date();
  const { period: p, kind, offset, year, years } = await resolveViewPeriod(user.id, await searchParams, now);
  const prev = monthPeriod(now, offset - 1);
  const [s, sPrev, cats, big, trend, cadence] = await Promise.all([
    summary(user.id, p), summary(user.id, prev), spendingByCategory(user.id, p),
    largest(user.id, p, "DEBIT", 8), monthlyTrendFor(user.id, p), loadCadence(user.id, now),
  ]);
  const bills = cadence.streams.filter((b) => b.type === "DEBIT");
  const split = await spendingSplit(user.id, p, cadence);
  const reviewQuestions = user.isDemo ? 0 : await reviewQuestionsFor(user.id, split.unlabelled);
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
      <PageHeader title="Spending" subtitle="Own-account transfers are excluded from spending." action={<PeriodSwitcher kind={kind} offset={offset} year={year} years={years} basePath="/app/spending" />} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        <Stat label={`Spent in ${p.label}`} minor={s.expenses} emphasis hint={`${s.expenseCount} debits`} />
        {kind === "month" && <Stat label={`vs ${prev.label}`} minor={delta} hint={delta > 0n ? "More than previous month" : delta < 0n ? "Less than previous month" : "Same as previous month"} />}
        <Stat label="Recurring per month" minor={monthlyBills} hint={`${bills.length} recurring payments`} />
      </div>
      <Card title="Recurring vs one-off" className="mt-4" action={<Link href="/app/afford" className="text-sm text-brand">Can I afford it?</Link>}>
        {!split.labelled ? (
          <Empty>Ledger only labels the last 6 months, the window it uses to find regular payments.</Empty>
        ) : (
          <>
            <div className="mb-3 empty:hidden"><ReviewCta unlabelled={split.unlabelled} reviewQuestions={reviewQuestions} period={p} /></div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { label: "Recurring bills", minor: split.recurringBillsMinor, hint: "Rent, family support, loan instalments, utilities, subscriptions", href: "/app/transactions?cadence=recurring" },
                { label: "Other regular payments", minor: split.recurringOtherMinor, hint: "Paid monthly or several times a month, but not a bill", href: "/app/transactions?cadence=recurring" },
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
        <Card title="What you spent on" action={<span className="text-xs text-ink-3">Spellings of the same person or shop are matched</span>}>
          {split.payees.length ? <PayeeList payees={split.payees} period={p} /> : <Empty>No spending in {p.label}.</Empty>}
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
                    <div className="truncate font-medium">{b.name}{b.label ? <span className="text-ink-3 font-normal"> · {b.label}</span> : null}</div>
                    <div className="text-xs text-ink-3">{b.category}{cadence.recurring.get(b.transactionIds[0])?.bill ? " · bill" : ""} · {recurringKindLabel(b.kind)} · seen {b.occurrences}x in {b.months} months · next ~{lagosDateLabel(b.nextExpected, { day: "numeric", month: "short" })}</div>
                    {b.aliases.length > 0 && <div className="text-xs text-ink-3 truncate">Also written as {b.aliases.slice(0, 3).join(", ")}</div>}
                  </div>
                  <span className="shrink-0 text-right"><Money minor={b.averageMinor} />{b.kind === "frequent" && <div className="text-xs text-ink-3">a month</div>}</span>
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
