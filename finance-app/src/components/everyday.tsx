import Link from "next/link";
import type { Period } from "@/core/analytics";
import type { EverydayBreakdown } from "@/core/cadence";
import { formatMoney } from "@/lib/money";
import { CategoryBars } from "@/components/charts";
import { Empty, Money } from "@/components/ui";

const lagosDay = (d: Date) => new Date(d.getTime() + 3600_000).toISOString().slice(0, 10);

/** Transactions list for a period's everyday spending; `extra` adds filters such as a category. */
export function everydayHref(p: Pick<Period, "from" | "to">, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ cadence: "everyday", from: lagosDay(p.from), to: lagosDay(new Date(p.to.getTime() - 1)), ...extra });
  return `/app/transactions?${q}`;
}

/** "X payments need a purpose": shown when unlabelled transfers make up much of everyday spending. */
export function EverydayReviewCta({ everyday, reviewQuestions, period }: { everyday: EverydayBreakdown; reviewQuestions: number; period: Pick<Period, "from" | "to"> }) {
  if (!everyday.needsReview) return null;
  const { count, totalMinor } = everyday.opaque;
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
                : <Link href={everydayHref(period, { q: m.name.slice(0, 80) })} className="truncate hover:underline">{m.name}</Link>}
              <span className="shrink-0 text-ink-2"><Money minor={m.totalMinor} /> <span className="text-ink-3 text-xs">· {m.count}</span></span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
