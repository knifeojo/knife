import { ALL_CATEGORIES } from "@/core/categorize";
import { categoryMonthDetail, monthPeriod, periodFromYearMonth } from "@/core/analytics";
import { apiError, apiJson, requireApiUser } from "@/lib/mobile/http";
import { minor } from "@/lib/mobile/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ category: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const { category: raw } = await params;
  const category = decodeURIComponent(raw);
  if (!(ALL_CATEGORIES as readonly string[]).includes(category)) return apiError(400, "Unknown category");

  const month = new URL(req.url).searchParams.get("month");
  const period = month ? periodFromYearMonth(month) : monthPeriod(new Date(), 0);
  if ("error" in period) return apiError(400, period.error);

  const detail = await categoryMonthDetail(auth.user.id, category, period);
  return apiJson({
    category,
    period: { label: period.label, from: period.from.toISOString(), to: period.to.toISOString() },
    totalMinor: minor(detail.total),
    count: detail.count,
    shareBp: detail.shareBp,
    avg6mMinor: minor(detail.avg6mMinor),
    subcategories: detail.subcategories.map((row) => ({
      name: row.name,
      totalMinor: minor(row.total),
      count: row.count,
    })),
  });
}
