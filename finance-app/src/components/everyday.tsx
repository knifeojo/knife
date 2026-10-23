import Link from "next/link";
import type { Period } from "@/core/analytics";
import type { RecurringKind } from "@/core/analytics";
import type { EverydayBreakdown, PayeeSpend, Unlabelled } from "@/core/cadence";
import { formatMoney } from "@/lib/money";
import { CategoryBars } from "@/components/charts";
import { Badge, Empty, Money } from "@/components/ui";

const lagosDay = (d: Date) => new Date(d.getTime() + 3600_000).toISOString().slice(0, 10);

/** Transactions list for a period's everyday spending; `extra` adds filters such as a category. */
export function everydayHref(p: Pick<Period, "from" | "to">, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ cadence: "everyday", from: lagosDay(p.from), to: lagosDay(new Date(p.to.getTime() - 1)), ...extra });
  return `/app/transactions?${q}`;
}

/** "X payments need a purpose": shown when unlabelled transfers make up much of the month's spending. */
export function ReviewCta({ unlabelled, reviewQuestions, period }: { unlabelled: Unlabelled; reviewQuestions: number; period: Pick<Period, "from" | "to"> }) {
  if (!unlabelled.needsReview) return null;
  const { count, totalMinor } = unlabelled;
  const href = reviewQuestions > 0 ? "/app/review" : everydayHref(period, { category: "Transfers" });
  return (
    <Link href={href} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-accent-soft px-4 py-3 text-sm hover:opacity-90">
      <span>
        <strong className="num">{count} payment{count === 1 ? "" : "s"} ({formatMoney(totalMinor, "NGN", { compact: true })})</strong> need a purpose.
        {" "}Your bank only recorded who you paid, so Ledger left them in Transfers. Help Ledger label them.
      </span>
      <span className="font-medium text-accent">{reviewQuestions > 0 ? `Answer ${reviewQuestions} question${reviewQuestions === 1 ? "" : "s"}` : "Label them"}</span>
    </Link>
  );
}

/** Everyday spending by category and by payee, each linking to the matching transactions. */
export function EverydayBreakdownView({ everyday, period }: { everyday: EverydayBreakdown; period: Pick<Period, "from" | "to"> }) {
  if (!everyday.count) return <Empty>No everyday spending in this period.</Empty>;
  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <div>
        <h3 className="text-xs text-ink-3 mb-2">By category</h3>
        <CategoryBars
          data={everyday.byCategory.map((c) => ({ label: c.name, value: c.totalMinor, count: c.count, href: everydayHref(period, { category: c.name }) }))}
          total={everyday.totalMinor}
        />
      </div>
      <div>
        <h3 className="text-xs text-ink-3 mb-2">Who you paid</h3>
        <ul className="divide-y divide-border">
          {everyday.byPayee.map((m) => (
            <li key={m.name} className="flex justify-between py-2 text-sm gap-3">
              {m.name === "Unnamed payments"
                ? <span className="truncate text-ink-2">{m.name}</span>
                : <Link href={everydayHref(period, { payee: m.name.slice(0, 80) })} className="truncate hover:underline">{m.name}</Link>}
              <span className="shrink-0 text-ink-2"><Money minor={m.totalMinor} /> <span className="text-ink-3 text-xs">· {m.count}</span></span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function recurringKindLabel(kind: RecurringKind): string {
  return kind === "fixed" ? "monthly" : kind === "variable" ? "monthly, amount varies" : "several times a month";
}

/** "What you spent on": matched people and shops with their totals, each linking to its transactions. */
export function PayeeList({ payees, period }: { payees: PayeeSpend[]; period: Pick<Period, "from" | "to"> }) {
  const range = { from: lagosDay(period.from), to: lagosDay(new Date(period.to.getTime() - 1)) };
  return (
    <ul className="divide-y divide-border">
      {payees.map((m) => {
        const parts = [
          m.recurringMinor > 0n && `${formatMoney(m.recurringMinor, "NGN", { compact: true })} regular`,
          m.oneOffMinor > 0n && `${formatMoney(m.oneOffMinor, "NGN", { compact: true })} one-off`,
          m.everydayMinor > 0n && `${formatMoney(m.everydayMinor, "NGN", { compact: true })} everyday`,
        ].filter(Boolean);
        return (
          <li key={m.name} className="flex justify-between py-2.5 text-sm gap-3">
            <div className="min-w-0">
              <div className="truncate font-medium">
                {m.unnamed
                  ? <span className="text-ink-2">{m.name}</span>
                  : <Link href={`/app/transactions?${new URLSearchParams({ payee: m.name.slice(0, 80), type: "DEBIT", ...range })}`} className="hover:underline">{m.name}</Link>}
                {m.label && <span className="text-ink-3 font-normal"> · {m.label}</span>}
              </div>
              <div className="text-xs text-ink-3">
                {m.category} · {m.count} payment{m.count === 1 ? "" : "s"}{parts.length ? ` · ${parts.join(" · ")}` : ""}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {m.regular && <Badge tone="brand">{recurringKindLabel(m.regular)}</Badge>}
                {m.unlabelledMinor > 0n && <Badge tone="warn">no purpose yet</Badge>}
                {m.variants.length > 0 && <span className="text-xs text-ink-3 truncate">also {m.variants.slice(0, 2).join(", ")}{m.variants.length > 2 ? ` +${m.variants.length - 2}` : ""}</span>}
              </div>
            </div>
            <Money minor={m.totalMinor} className="shrink-0" />
          </li>
        );
      })}
    </ul>
  );
}
