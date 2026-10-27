import Link from "next/link";
import { redirect } from "next/navigation";
import { balances, incomeSources, largest, monthPeriod, monthlyTrend, recurring, spendingByCategory, summary } from "@/core/analytics";
import { loadCadence } from "@/core/cadence";
import { onboardingState } from "@/core/onboarding";
import { buildQuestions } from "@/core/review";
import { formatMoney } from "@/lib/money";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { CategoryBars, MonthlyBars } from "@/components/charts";
import { MonthSwitcher, resolveOffset } from "@/components/month-switcher";
import { Card, Empty, Money, PageHeader, Stat, lagosDateLabel, relativeTime } from "@/components/ui";
import { TxTable } from "@/components/tx-table";
import { StatementUpload } from "@/components/statement-upload";
import { TopPeopleCard } from "./top-people";

export default async function Overview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const offset = await resolveOffset(user.id, (await searchParams).m);
  const now = new Date();
  const period = monthPeriod(now, offset);

  const [txCount, welcome] = await Promise.all([
    db.transaction.count({ where: { userId: user.id } }),
    onboardingState(user.id),
  ]);
  if (welcome.needsOnboarding) redirect("/app/welcome");
  if (txCount === 0) return <Onboarding />;

  const [s, bal, cats, trend, recent, bills, big, lastConn, sources, questions, cadence, peopleCount] = await Promise.all([
    summary(user.id, period),
    balances(user.id),
    spendingByCategory(user.id, period),
    monthlyTrend(user.id, now, 6),
    db.transaction.findMany({ where: { userId: user.id }, orderBy: { transactionDate: "desc" }, take: 6 }),
    recurring(user.id, now, "DEBIT"),
    largest(user.id, period, "DEBIT", 3),
    db.financialConnection.findFirst({ where: { userId: user.id, status: "active" }, orderBy: { lastSyncedAt: "desc" } }),
    incomeSources(user.id, period),
    user.isDemo ? Promise.resolve([]) : buildQuestions(user.id),
    loadCadence(user.id, now),
    db.person.count({ where: { userId: user.id } }),
  ]);
  const peopleAsked = questions.filter((q) => q.person).length;
  const latestBalanceDate = bal.accounts.reduce<Date | null>((d, a) => (a.balanceUpdatedAt && (!d || a.balanceUpdatedAt > d) ? a.balanceUpdatedAt : d), null);

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`Last synced ${relativeTime(lastConn?.lastSyncedAt)}`}
        action={<MonthSwitcher offset={offset} basePath="/app" />}
      />

      {welcome.topPeople.show && <TopPeopleCard people={welcome.topPeople.people} />}

      {peopleCount === 0 && peopleAsked > 0 && !welcome.topPeople.show && (
        <Link href="/app/people" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent/40 px-4 py-3 text-sm hover:opacity-90" data-testid="people-onboarding">
          <span>
            <strong>Who are your people?</strong> Ledger found {peopleAsked} {peopleAsked === 1 ? "person" : "people"} you send money to. Tell it who your spouse, siblings and parents are, and their payments are labelled for you.
          </span>
          <span className="font-medium text-accent">Add your family</span>
        </Link>
      )}

      {questions.length > 0 && (
        <Link href="/app/review" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-accent-soft px-4 py-3 text-sm hover:opacity-90">
          <span>
            <strong>{questions.length} quick questions</strong> will correctly label{" "}
            {formatMoney(questions.reduce((t, q) => t + q.totalMinor, 0n), "NGN", { compact: true })} of your transactions.
          </span>
          <span className="font-medium text-accent">Answer now</span>
        </Link>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Balance" minor={bal.totalBase} emphasis hint={latestBalanceDate ? `Latest reported, ${lagosDateLabel(latestBalanceDate)}` : "No balance reported yet"} />
        <Stat
          label="Income"
          minor={s.income}
          hint={`${s.incomeCount} credits${s.ratesUsed.length ? ` · includes ${s.ratesUsed.map((r) => `${r.currency} at your rate of ₦${r.rate.toFixed(0)}`).join(", ")}` : ""}${s.unconverted.length ? ` · ${s.unconverted.map((u) => u.currencyAndType.split(" ")[0]).join(", ")} not included yet` : ""}`}
        />
        <Stat label="Expenses" minor={s.expenses} hint={`${s.expenseCount} debits`} />
        <Stat label="Net cash flow" minor={s.net} hint={`${s.count} transactions in ${period.label}`} />
      </div>

      <div className="grid lg:grid-cols-5 gap-4 mt-4">
        <Card title="Income vs expenses" className="lg:col-span-3">
          <MonthlyBars data={trend} />
        </Card>
        <Card title={`Spending by category`} className="lg:col-span-2" action={<Link href={`/app/spending?m=${offset}`} className="text-sm text-accent">Details</Link>}>
          {cats.length ? <CategoryBars data={cats.slice(0, 6).map((c) => ({ label: c.category, value: c.total, count: c.count }))} total={s.expenses} /> : <Empty>No spending in {period.label}.</Empty>}
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        <Card title="Recent transactions" className="lg:col-span-2" action={<Link href="/app/transactions" className="text-sm text-accent">View all</Link>}>
          <TxTable rows={recent} showBalance={false} cadence={cadence} />
        </Card>
        <div className="space-y-4">
          <Card title="Income sources" action={<Link href={`/app/income?m=${offset}`} className="text-sm text-accent">Details</Link>}>
            {sources.length ? (
              <ul className="space-y-3">
                {sources.map((x) => (
                  <li key={x.name} className="flex justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{x.name}</div>
                      <div className="text-xs text-ink-3">{x.kind} · {x.count} payment{x.count > 1 ? "s" : ""}</div>
                    </div>
                    <Money minor={x.total} className="text-credit shrink-0" />
                  </li>
                ))}
              </ul>
            ) : <Empty>No income in {period.label}.</Empty>}
          </Card>
          <Card title="Recurring payments" action={<span className="text-xs text-ink-3">{bills.length} found</span>}>
            {bills.length ? (
              <ul className="space-y-3">
                {bills.slice(0, 5).map((b) => (
                  <li key={b.key} className="flex justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{b.name}</div>
                      <div className="text-xs text-ink-3">{b.category} · next ~{lagosDateLabel(b.nextExpected, { day: "numeric", month: "short" })}</div>
                    </div>
                    <Money minor={b.averageMinor} className="text-ink-2 shrink-0" />
                  </li>
                ))}
              </ul>
            ) : <Empty>Needs 2+ months of history.</Empty>}
          </Card>
          <Card title="Largest expenses">
            {big.length ? (
              <ul className="space-y-3">
                {big.map((t) => (
                  <li key={t.id} className="flex justify-between gap-3 text-sm">
                    <span className="truncate">{t.merchantName ?? t.counterparty ?? t.description}</span>
                    <Money minor={t.amountMinor} className="shrink-0" />
                  </li>
                ))}
              </ul>
            ) : <Empty>No expenses this month.</Empty>}
          </Card>
        </div>
      </div>
    </>
  );
}

function Onboarding() {
  return (
    <div className="max-w-2xl">
      <PageHeader title="Welcome" subtitle="Let's build your financial history." />
      <Card>
        <h2 className="text-lg font-semibold">Connect your bank alerts</h2>
        <p className="text-sm text-ink-2 mt-2">
          GTBank emails you an alert for every transaction. Connect Gmail with read-only access and we will turn those alerts into a clean, searchable ledger.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/app/accounts/connect" className="btn btn-primary">Connect Gmail</Link>

        </div>
        <p className="mt-4 text-xs text-ink-3">We never ask for your bank login, PIN, OTP or card details.</p>
      </Card>
      <Card className="mt-4">
        <h2 className="text-lg font-semibold">Or upload bank statements</h2>
        <p className="text-sm text-ink-2 mt-2 mb-4">
          Download statements from any Nigerian bank as PDF, CSV or Excel and upload one or several. Works without Gmail.
        </p>
        <StatementUpload compact />
      </Card>
    </div>
  );
}
