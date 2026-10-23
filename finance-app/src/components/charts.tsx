import Link from "next/link";
import { formatMoney } from "@/lib/money";

// Lightweight HTML charts. Colors follow the validated reference palette via CSS roles
// (--series-1 income, --series-2 expenses). Values in text ink, never series color.
// Every mark has a hover/focus tooltip; a table view sits under each chart.

export function MonthlyBars({ data }: { data: { label: string; income: bigint; expenses: bigint }[] }) {
  const max = data.reduce((m, d) => (d.income > m ? d.income : d.expenses > m ? d.expenses : m), 1n);
  const h = (v: bigint) => `${Math.max(Number((v * 1000n) / max) / 10, v > 0n ? 1.5 : 0)}%`;
  return (
    <figure>
      <div className="flex items-center gap-4 text-xs text-ink-2 mb-3" aria-hidden>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: "var(--series-1)" }} />Income</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: "var(--series-2)" }} />Expenses</span>
      </div>
      <div className="relative h-44">
        <div className="absolute inset-0 flex flex-col justify-between pointer-events-none" aria-hidden>
          {[0, 1, 2, 3].map((i) => <div key={i} className="border-t" style={{ borderColor: "var(--grid)" }} />)}
        </div>
        <div className="relative h-full flex items-end gap-3 sm:gap-6">
          {data.map((d) => (
            <div key={d.label} className="flex-1 h-full flex items-end justify-center gap-[2px]">
              {([["Income", d.income, "--series-1"], ["Expenses", d.expenses, "--series-2"]] as const).map(([name, v, color]) => (
                <div
                  key={name}
                  tabIndex={0}
                  className="viz-mark w-full max-w-5 rounded-t-[4px] outline-none"
                  style={{ height: h(v), background: `var(${color})` }}
                  aria-label={`${d.label} ${name}: ${formatMoney(v)}`}
                >
                  <span className="viz-tip num">{d.label} {name}: {formatMoney(v)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="flex gap-3 sm:gap-6 mt-2">
        {data.map((d) => <div key={d.label} className="flex-1 text-center text-xs text-ink-3">{d.label}</div>)}
      </div>
      <details className="mt-3 text-xs text-ink-2">
        <summary className="cursor-pointer text-ink-3">Table view</summary>
        <table className="mt-2 w-full num">
          <thead><tr className="text-ink-3"><th className="text-left font-normal">Month</th><th className="text-right font-normal">Income</th><th className="text-right font-normal">Expenses</th></tr></thead>
          <tbody>{data.map((d) => <tr key={d.label}><td>{d.label}</td><td className="text-right">{formatMoney(d.income)}</td><td className="text-right">{formatMoney(d.expenses)}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}

/** Single-series magnitude bars (one hue), direct-labelled with value and share. */
export function CategoryBars({ data, total }: { data: { label: string; value: bigint; count?: number; note?: string; href?: string }[]; total: bigint }) {
  const max = data.reduce((m, d) => (d.value > m ? d.value : m), 1n);
  return (
    <ul className="space-y-3">
      {data.map((d) => {
        const pct = total > 0n ? Number((d.value * 1000n) / total) / 10 : 0;
        return (
          <li key={d.label}>
            <div className="flex items-baseline justify-between text-sm gap-2">
              {d.href ? <Link href={d.href} className="truncate hover:underline">{d.label}</Link> : <span className="truncate">{d.label}</span>}
              <span className="num text-ink-2 shrink-0">
                {formatMoney(d.value, "NGN", { compact: true })} <span className="text-ink-3">· {pct.toFixed(0)}%</span>
              </span>
            </div>
            {d.note && <div className="text-xs text-ink-3">{d.note}</div>}
            <div className="mt-1.5 h-2 rounded-full bg-surface-2">
              <div
                tabIndex={0}
                className="viz-mark h-2 rounded-full outline-none"
                style={{ width: `${Math.max(Number((d.value * 1000n) / max) / 10, 1)}%`, background: "var(--series-1)" }}
                aria-label={`${d.label}: ${formatMoney(d.value)}`}
              >
                <span className="viz-tip num">{d.label}: {formatMoney(d.value)}{d.count ? ` · ${d.count} txns` : ""}</span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
