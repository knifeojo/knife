import { basisPoints, monthPeriod, periodFromYearMonth } from "@/core/analytics";
import { monthOverview } from "@/core/overview";
import { apiError, apiJson, requireApiUser } from "@/lib/mobile/http";
import { minor } from "@/lib/mobile/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const month = new URL(req.url).searchParams.get("month");
  const period = month ? periodFromYearMonth(month) : monthPeriod(new Date(), 0);
  if ("error" in period) return apiError(400, period.error);

  const data = await monthOverview(auth.user.id, period);
  const out = data.figures.expenses;
  const local = new Date(period.from.getTime() + 3600_000);
  const monthKey = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}`;
  return apiJson({
    period: { label: period.label, from: period.from.toISOString(), to: period.to.toISOString(), month: monthKey },
    inMinor: minor(data.figures.income),
    outMinor: minor(data.figures.expenses),
    leftMinor: minor(data.figures.net),
    keptBp: data.figures.savingsRate === null ? null : basisPoints(data.figures.net, data.figures.income),
    prevOutMinor: minor(data.prevOut),
    reviewCount: data.reviewCount,
    categories: data.categories.map((row) => ({
      category: row.category,
      totalMinor: minor(row.total),
      count: row.count,
      shareBp: basisPoints(row.total, out),
    })),
    incomeSources: data.sources.map((row) => ({
      name: row.name,
      kind: row.kind,
      totalMinor: minor(row.total),
      count: row.count,
    })),
  });
}
