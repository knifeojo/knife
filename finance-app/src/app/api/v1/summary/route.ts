import { balances, listTransactions, monthPeriod, spendingByCategory, specificMonth, summary, type Period } from "@/core/analytics";
import { reviewQuestionsFor, loadCadence, spendingSplit, type EverydayGroup } from "@/core/cadence";
import { apiError, apiJson, requireApiUser } from "@/lib/mobile/http";
import { minor, transactionJson } from "@/lib/mobile/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolvePeriod(url: URL): { period: Period } | { error: string } {
  const month = url.searchParams.get("month");
  if (month) {
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match) return { error: "month must be YYYY-MM" as const };
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    if (monthIndex < 0 || monthIndex > 11 || year < 2000 || year > 2100) return { error: "month must be YYYY-MM" as const };
    return { period: specificMonth(year, monthIndex) };
  }
  const raw = url.searchParams.get("offset") ?? "0";
  if (!/^-?\d+$/.test(raw)) return { error: "offset must be an integer from -36 to 0" as const };
  const offset = Number(raw);
  if (offset > 0 || offset < -36) return { error: "offset must be an integer from -36 to 0" as const };
  return { period: monthPeriod(new Date(), offset) };
}

export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const resolved = resolvePeriod(new URL(req.url));
  if ("error" in resolved) return apiError(400, resolved.error);
  const { period } = resolved;

  const [figures, bal, categories, recent, cadence] = await Promise.all([
    summary(auth.user.id, period),
    balances(auth.user.id),
    spendingByCategory(auth.user.id, period),
    listTransactions(auth.user.id, {}, 1, 8),
    loadCadence(auth.user.id),
  ]);
  const split = await spendingSplit(auth.user.id, period, cadence);
  const reviewQuestions = await reviewQuestionsFor(auth.user.id, split.unlabelled);
  const group = (g: EverydayGroup) => ({ name: g.name, totalMinor: minor(g.totalMinor), count: g.count });
  const debitStreams = cadence.streams.filter((st) => st.type === "DEBIT");

  return apiJson({
    period: { label: period.label, from: period.from.toISOString(), to: period.to.toISOString() },
    incomeMinor: minor(figures.income),
    expensesMinor: minor(figures.expenses),
    netMinor: minor(figures.net),
    count: figures.count,
    incomeCount: figures.incomeCount,
    expenseCount: figures.expenseCount,
    balanceMinor: minor(bal.totalBase),
    balanceCurrency: "NGN",
    spendingByCategory: categories.map((row) => ({
      category: row.category, totalMinor: minor(row.total), count: row.count,
      recurringMinor: minor(split.byCategory.get(row.category)?.recurringMinor ?? 0n),
      oneOffMinor: minor(split.byCategory.get(row.category)?.oneOffMinor ?? 0n),
    })),
    spendingSplit: {
      recurringBillsMinor: minor(split.recurringBillsMinor),
      recurringOtherMinor: minor(split.recurringOtherMinor),
      oneOffMinor: minor(split.oneOffMinor),
      everydayMinor: minor(split.everydayMinor),
      oneOffMinMinor: minor(split.oneOffMinMinor),
      labelled: split.labelled,
      oneOffs: split.oneOffs.map((o) => ({ id: o.id, name: o.name, category: o.category, subcategory: o.subcategory, amountMinor: minor(o.amountMinor), date: o.date.toISOString() })),
      everyday: {
        totalMinor: minor(split.everyday.totalMinor),
        count: split.everyday.count,
        byCategory: split.everyday.byCategory.map(group),
        byPayee: split.everyday.byPayee.map(group),
      },
      payees: split.payees.map((x) => ({
        name: x.name, label: x.label, category: x.category, totalMinor: minor(x.totalMinor), count: x.count,
        recurringMinor: minor(x.recurringMinor), oneOffMinor: minor(x.oneOffMinor), everydayMinor: minor(x.everydayMinor),
        regular: x.regular, unlabelledMinor: minor(x.unlabelledMinor), variants: x.variants, unnamed: x.unnamed,
      })),
      unlabelled: { count: split.unlabelled.count, totalMinor: minor(split.unlabelled.totalMinor), needsReview: split.unlabelled.needsReview, reviewQuestions },
    },
    /** Regular payments by matched payee name, the same list as the web Spending page. */
    recurring: debitStreams.map((st) => ({
      name: st.name, label: st.label ?? null, category: st.category, kind: st.kind, bill: !!cadence.recurring.get(st.transactionIds[0])?.bill,
      averageMinor: minor(st.averageMinor), occurrences: st.occurrences, months: st.months,
      lastDate: st.lastDate.toISOString(), nextExpected: st.nextExpected.toISOString(), aliases: st.aliases,
    })),
    ratesUsed: figures.ratesUsed.map((rate) => ({ currency: rate.currency, rate: rate.rate, conversions: rate.conversions })),
    unconverted: figures.unconverted.map((row) => ({ currencyAndType: row.currencyAndType, totalMinor: minor(row.totalMinor) })),
    recent: recent.rows.map((tx) => transactionJson(tx, cadence)),
  });
}
