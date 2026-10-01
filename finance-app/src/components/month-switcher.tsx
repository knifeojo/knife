import Link from "next/link";
import { monthPeriod } from "@/core/analytics";
import { db } from "@/lib/db";

export function parseOffset(v: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(v) ? v[0] : v;
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n <= 0 && n > -36 ? n : undefined;
}

/**
 * The month to show: the one in the URL, else the current month if it has transactions, else the
 * latest month that does (so a statement imported on the 1st still opens on last month).
 */
export async function resolveOffset(userId: string, v: string | string[] | undefined, now = new Date()): Promise<number> {
  const explicit = parseOffset(v);
  if (explicit !== undefined) return explicit;
  const current = monthPeriod(now, 0);
  const latest = await db.transaction.findFirst({ where: { userId, transactionDate: { lt: current.to } }, orderBy: { transactionDate: "desc" }, select: { transactionDate: true } });
  if (!latest || latest.transactionDate >= current.from) return 0;
  const lagos = (d: Date) => new Date(d.getTime() + 3600_000);
  const a = lagos(now), b = lagos(latest.transactionDate);
  return -((a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth()));
}

export function MonthSwitcher({ offset, basePath, now = new Date() }: { offset: number; basePath: string; now?: Date }) {
  const p = monthPeriod(now, offset);
  return (
    <div className="inline-flex items-center gap-1 card px-1 h-10">
      <Link href={`${basePath}?m=${offset - 1}`} className="btn btn-ghost h-8 px-2" aria-label="Previous month">‹</Link>
      <span className="text-sm font-medium min-w-32 text-center">{p.label}</span>
      {offset < 0 ? (
        <Link href={`${basePath}?m=${offset + 1}`} className="btn btn-ghost h-8 px-2" aria-label="Next month">›</Link>
      ) : (
        <span className="btn btn-ghost h-8 px-2 opacity-30" aria-hidden>›</span>
      )}
    </div>
  );
}
