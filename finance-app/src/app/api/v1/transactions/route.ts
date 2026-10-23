import { ALL_CATEGORIES } from "@/core/categorize";
import { listTransactions, type TransactionFilters } from "@/core/analytics";
import { apiError, apiJson, requireApiUser } from "@/lib/mobile/http";
import { cadenceWhere, loadCadence, parseCadenceView, payeeWhere } from "@/core/cadence";
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
  const category = url.searchParams.get("category") || undefined;
  if (category && !(ALL_CATEGORIES as readonly string[]).includes(category)) return apiError(400, "Unknown category");

  const pageRaw = url.searchParams.get("page") ?? "1";
  const sizeRaw = url.searchParams.get("pageSize") ?? "50";
  if (!/^\d+$/.test(pageRaw) || !/^\d+$/.test(sizeRaw)) return apiError(400, "page and pageSize must be positive integers");
  const page = Number(pageRaw);
  const pageSize = Number(sizeRaw);
  if (page < 1 || page > 10_000 || pageSize < 1 || pageSize > 100) return apiError(400, "pageSize must be between 1 and 100");

  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  if ((fromRaw && !/^\d{4}-\d{2}-\d{2}$/.test(fromRaw)) || (toRaw && !/^\d{4}-\d{2}-\d{2}$/.test(toRaw))) {
    return apiError(400, "Dates must be YYYY-MM-DD");
  }
  const from = lagosDay(fromRaw);
  const toStart = lagosDay(toRaw);
  const accountId = url.searchParams.get("accountId") || undefined;
  if (accountId && accountId.length > 64) return apiError(400, "Unknown account");
  const cadenceParam = url.searchParams.get("cadence") || undefined;
  const cadenceView = parseCadenceView(cadenceParam);
  if (cadenceParam && !cadenceView) return apiError(400, "cadence must be recurring, one_off or everyday");

  const payee = url.searchParams.get("payee")?.trim().slice(0, 80) || undefined;
  const cadence = await loadCadence(auth.user.id);

  const filters: TransactionFilters = {
    q: url.searchParams.get("q")?.slice(0, 80) || undefined,
    type: type === "DEBIT" || type === "CREDIT" ? type : undefined,
    category,
    accountId,
    from,
    to: toStart ? new Date(toStart.getTime() + 86400_000) : undefined,
    cadence: cadenceView ? await cadenceWhere(auth.user.id, cadence, cadenceView) : undefined,
    payee: payee ? await payeeWhere(auth.user.id, payee) : undefined,
  };
  const data = await listTransactions(auth.user.id, filters, page, pageSize);
  return apiJson({
    transactions: data.rows.map((tx) => transactionJson(tx, cadence)),
    total: data.total,
    page: data.page,
    pageSize: data.pageSize,
    categories: ALL_CATEGORIES,
    oneOffMinMinor: minor(cadence.oneOffMinMinor),
    cadenceSince: cadence.since.toISOString(),
  });
}
