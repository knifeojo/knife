import Link from "next/link";
import {
  allTimePeriod, availableYears, calendarYearPeriod, lastNMonthsPeriod, monthPeriod, ytdPeriod, type Period,
} from "@/core/analytics";
import { MonthSwitcher, resolveOffset } from "./month-switcher";

export type PeriodKind = "month" | "3m" | "ytd" | "12m" | "all" | "year";

const KINDS: { value: PeriodKind; label: string }[] = [
  { value: "month", label: "This month" },
  { value: "3m", label: "Last 3 months" },
  { value: "ytd", label: "Year to date" },
  { value: "12m", label: "Last 12 months" },
  { value: "all", label: "All time" },
];

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function parsePeriodKind(v: string | string[] | undefined): PeriodKind {
  const raw = one(v);
  if (raw === "3m" || raw === "ytd" || raw === "12m" || raw === "all" || raw === "year" || raw === "month") return raw;
  return "month";
}

export function parseYear(v: string | string[] | undefined, fallback: number): number {
  const n = Number(one(v));
  return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : fallback;
}

export function periodQuery(kind: PeriodKind, opts: { offset?: number; year?: number } = {}): string {
  if (kind === "month") return opts.offset ? `p=month&m=${opts.offset}` : "p=month";
  if (kind === "year") return `p=year&y=${opts.year ?? new Date().getUTCFullYear()}`;
  return `p=${kind}`;
}

export async function resolveViewPeriod(
  userId: string,
  search: Record<string, string | string[] | undefined>,
  now = new Date(),
): Promise<{ period: Period; kind: PeriodKind; offset: number; year: number; years: number[] }> {
  const kind = parsePeriodKind(search.p);
  const years = await availableYears(userId);
  const year = parseYear(search.y, years[0] ?? now.getUTCFullYear());
  if (kind === "3m") return { period: lastNMonthsPeriod(now, 3), kind, offset: 0, year, years };
  if (kind === "ytd") return { period: ytdPeriod(now), kind, offset: 0, year, years };
  if (kind === "12m") return { period: lastNMonthsPeriod(now, 12), kind, offset: 0, year, years };
  if (kind === "all") return { period: await allTimePeriod(userId, now), kind, offset: 0, year, years };
  if (kind === "year") return { period: calendarYearPeriod(year), kind, offset: 0, year, years };
  const offset = await resolveOffset(userId, search.m, now);
  return { period: monthPeriod(now, offset), kind: "month", offset, year, years };
}

function chip(active: boolean) {
  return `btn h-8 px-2.5 text-xs ${active ? "btn-primary" : "btn-ghost"}`;
}

export function PeriodSwitcher({
  kind, offset, year, years, basePath,
}: {
  kind: PeriodKind;
  offset: number;
  year: number;
  years: number[];
  basePath: string;
}) {
  const href = (next: PeriodKind, extra: { offset?: number; year?: number } = {}) =>
    `${basePath}?${periodQuery(next, { offset: extra.offset ?? offset, year: extra.year ?? year })}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <nav className="flex flex-wrap items-center gap-1" aria-label="Period">
        {KINDS.map((k) => (
          <Link key={k.value} href={href(k.value)} className={chip(kind === k.value)}>{k.label}</Link>
        ))}
        {years.map((y) => (
          <Link key={y} href={href("year", { year: y })} className={chip(kind === "year" && year === y)}>{y}</Link>
        ))}
      </nav>
      {kind === "month" && <MonthSwitcher offset={offset} basePath={basePath} />}
    </div>
  );
}
