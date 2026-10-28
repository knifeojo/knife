import { ALL_CATEGORIES } from "@/core/categorize";
import {
  dayTotalsFor, decodeTxCursor, lagosDateKey, listTransactions, listTransactionsCursor, periodFromYearMonth,
  type TransactionFilters,
} from "@/core/analytics";
import { apiError, apiJson, requireApiUser } from "@/lib/mobile/http";
import { cadenceWhere, loadCadence, parseCadenceView, payeeWhere } from "@/core/cadence";
import { loadFxContext } from "@/core/fx/rates";
import { minor, transactionJson } from "@/lib/mobile/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function lagosDay(value: string | null): Date | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00+01:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  if (type && type !== "DEBIT" && type !== "CREDIT") return apiError(400, "type must be DEBIT or CREDIT");
  const direction = url.searchParams.get("direction");
  if (direction && direction !== "in" && direction !== "out") return apiError(400, "direction must be in or out");
  const fromDirection = direction === "in" ? "CREDIT" : direction === "out" ? "DEBIT" : undefined;
  if (type && fromDirection && type !== fromDirection) return apiError(400, "type and direction disagree");
  const resolvedType = fromDirection ?? (type === "DEBIT" || type === "CREDIT" ? type : undefined);

  const category = url.searchParams.get("category") || undefined;
  if (category && !(ALL_CATEGORIES as readonly string[]).includes(category)) return apiError(400, "Unknown category");
  const subcategory = url.searchParams.get("subcategory")?.trim().slice(0, 80) || undefined;

  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  if ((fromRaw && !/^\d{4}-\d{2}-\d{2}$/.test(fromRaw)) || (toRaw && !/^\d{4}-\d{2}-\d{2}$/.test(toRaw))) {
    return apiError(400, "Dates must be YYYY-MM-DD");
  }
  let from = lagosDay(fromRaw);
  let to = lagosDay(toRaw) ? new Date(lagosDay(toRaw)!.getTime() + 86400_000) : undefined;
  const month = url.searchParams.get("month");
  if (month) {
    const period = periodFromYearMonth(month);
    if ("error" in period) return apiError(400, period.error);
    if (!from) from = period.from;
    if (!to) to = period.to;
  }

  const accountId = url.searchParams.get("accountId") || undefined;
  if (accountId && accountId.length > 64) return apiError(400, "Unknown account");
  const cadenceParam = url.searchParams.get("cadence") || undefined;
  const cadenceView = parseCadenceView(cadenceParam);
  if (cadenceParam && !cadenceView) return apiError(400, "cadence must be recurring, one_off or everyday");

  const payee = url.searchParams.get("payee")?.trim().slice(0, 80) || undefined;
  const cadence = await loadCadence(auth.user.id);

  const filters: TransactionFilters = {
    q: url.searchParams.get("q")?.slice(0, 80) || undefined,
    type: resolvedType,
    category,
    subcategory,
    accountId,
    from,
    to,
    cadence: cadenceView ? await cadenceWhere(auth.user.id, cadence, cadenceView) : undefined,
    payee: payee ? await payeeWhere(auth.user.id, payee) : undefined,
  };

  const cursorRaw = url.searchParams.get("cursor");
  const limitRaw = url.searchParams.get("limit");
  const useCursor = cursorRaw !== null || limitRaw !== null;
  const fx = await loadFxContext(auth.user.id);

  const extras = {
    categories: ALL_CATEGORIES,
    oneOffMinMinor: minor(cadence.oneOffMinMinor),
    cadenceSince: cadence.since.toISOString(),
  };

  if (useCursor) {
    const sizeRaw = limitRaw ?? "30";
    if (!/^\d+$/.test(sizeRaw)) return apiError(400, "limit must be a positive integer");
    const limit = Number(sizeRaw);
    if (limit < 1 || limit > 100) return apiError(400, "limit must be between 1 and 100");
    let cursor;
    if (cursorRaw) {
      cursor = decodeTxCursor(cursorRaw);
      if (!cursor) return apiError(400, "cursor is not valid");
    }
    const data = await listTransactionsCursor(auth.user.id, filters, limit, cursor);
    const days = [...new Set(data.rows.map((tx) => lagosDateKey(tx.transactionDate)))];
    const dayTotals = await dayTotalsFor(auth.user.id, filters, days);
    return apiJson({
      transactions: data.rows.map((tx) => transactionJson(tx, cadence, fx)),
      nextCursor: data.nextCursor,
      dayTotals: dayTotals.map((d) => ({
        date: d.date,
        netMinor: minor(d.netMinor),
        inMinor: minor(d.inMinor),
        outMinor: minor(d.outMinor),
      })),
      ...extras,
    });
  }

  const pageRaw = url.searchParams.get("page") ?? "1";
  const sizeRaw = url.searchParams.get("pageSize") ?? "50";
  if (!/^\d+$/.test(pageRaw) || !/^\d+$/.test(sizeRaw)) return apiError(400, "page and pageSize must be positive integers");
  const page = Number(pageRaw);
  const pageSize = Number(sizeRaw);
  if (page < 1 || page > 10_000 || pageSize < 1 || pageSize > 100) return apiError(400, "pageSize must be between 1 and 100");

  const data = await listTransactions(auth.user.id, filters, page, pageSize);
  return apiJson({
    transactions: data.rows.map((tx) => transactionJson(tx, cadence, fx)),
    total: data.total,
    page: data.page,
    pageSize: data.pageSize,
    ...extras,
  });
}
