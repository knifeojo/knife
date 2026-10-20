import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { BASE_CURRENCY, fxRates, monthPeriod, recurring, summary } from "./analytics";
import { OWN_TRANSFER } from "./categorize";
import { SKIPPED } from "./review";

// "What Ledger knows about you": facts derived from the user's own data and answers.
// Used as context for the AI categorizer and the assistant, and shown to the user so they can
// see (and correct) what the system believes.

export interface Profile {
  holderNames: string[];
  accounts: { name: string; balance: string; asOf?: string }[];
  monthsOfData: number;
  dataFrom?: string;
  dataTo?: string;
  monthly: { income: string; spending: string; net: string } | null;
  incomeSources: { name: string; kind: string; total: string; payments: number; typicalDay?: number }[];
  people: { name: string; label: string }[]; // from the user's answers and corrections
  commitments: { name: string; category: string; amount: string; nextAround: string }[];
  topSpending: { category: string; total: string }[];
}

export async function buildProfile(userId: string, now = new Date()): Promise<Profile> {
  const [accounts, aliases, credits, firstTx, debitsByCat] = await Promise.all([
    db.account.findMany({ where: { userId } }),
    db.merchantAlias.findMany({ where: { userId, category: { not: null } } }),
    db.transaction.findMany({
      where: { userId, type: "CREDIT", category: { notIn: [OWN_TRANSFER, "Debt"] }, transferPairId: null },
      select: { counterparty: true, merchantName: true, subcategory: true, amountMinor: true, transactionDate: true, currency: true },
    }),
    db.transaction.findFirst({ where: { userId }, orderBy: { transactionDate: "asc" }, select: { transactionDate: true } }),
    db.transaction.groupBy({
      by: ["category"],
      where: { userId, type: "DEBIT", currency: BASE_CURRENCY, category: { not: OWN_TRANSFER }, transferPairId: null },
      _sum: { amountMinor: true },
    }),
  ]);

  const lastTx = await db.transaction.findFirst({ where: { userId }, orderBy: { transactionDate: "desc" }, select: { transactionDate: true } });
  const months = firstTx && lastTx ? monthsBetween(firstTx.transactionDate, lastTx.transactionDate) + 1 : 0;

  // Monthly averages over the months that have data
  let monthly: Profile["monthly"] = null;
  if (lastTx && months > 0) {
    const lastOffset = -monthsBetween(lastTx.transactionDate, now);
    const periods = Array.from({ length: Math.min(months, 6) }, (_, i) => monthPeriod(now, lastOffset - i));
    const sums = await Promise.all(periods.map((p) => summary(userId, p)));
    const inc = sums.reduce((s, x) => s + x.income, 0n) / BigInt(sums.length);
    const exp = sums.reduce((s, x) => s + x.expenses, 0n) / BigInt(sums.length);
    monthly = { income: formatMoney(inc), spending: formatMoney(exp), net: formatMoney(inc - exp) };
  }

  const rates = await fxRates(userId);
  const sources = new Map<string, { kind: string; total: bigint; n: number; days: number[] }>();
  for (const c of credits) {
    // Foreign income counts at the user's own conversion rate; without a learned rate it is left out.
    const fx = c.currency === BASE_CURRENCY ? 1 : rates.get(c.currency)?.rate;
    if (!fx) continue;
    const name = c.merchantName ?? c.counterparty ?? "Unnamed transfers";
    const g = sources.get(name) ?? { kind: c.subcategory ?? "Other income", total: 0n, n: 0, days: [] };
    g.total += BigInt(Math.round(Number(c.amountMinor) * fx));
    g.n++;
    g.days.push(new Date(c.transactionDate.getTime() + 3600_000).getUTCDate());
    sources.set(name, g);
  }
  const incomeSources = [...sources.entries()]
    .sort((a, b) => (b[1].total > a[1].total ? 1 : -1))
    .slice(0, 6)
    .map(([name, g]) => ({ name, kind: g.kind, total: formatMoney(g.total), payments: g.n, typicalDay: g.n >= 2 ? median(g.days) : undefined }));

  const people = aliases
    .filter((a) => a.subcategory !== SKIPPED && a.pattern.includes(" "))
    .map((a) => ({ name: a.canonicalName, label: [a.category, a.subcategory].filter(Boolean).join(" / ") }))
    .slice(0, 40);

  const commitments = (await recurring(userId, now, "DEBIT", 12)).slice(0, 10).map((r) => ({
    name: r.name, category: r.category, amount: formatMoney(r.averageMinor),
    nextAround: new Date(r.nextExpected.getTime() + 3600_000).toISOString().slice(0, 10),
  }));

  return {
    holderNames: [...new Set(accounts.map((a) => a.holderName).filter((x): x is string => !!x))],
    accounts: accounts.map((a) => ({
      name: a.accountName,
      balance: formatMoney(a.balanceMinor ?? 0n, a.currency),
      asOf: a.balanceUpdatedAt?.toISOString().slice(0, 10),
    })),
    monthsOfData: months,
    dataFrom: firstTx?.transactionDate.toISOString().slice(0, 10),
    dataTo: lastTx?.transactionDate.toISOString().slice(0, 10),
    monthly,
    incomeSources,
    people,
    commitments,
    topSpending: debitsByCat
      .map((d) => ({ category: d.category, total: d._sum.amountMinor ?? 0n }))
      .sort((a, b) => (b.total > a.total ? 1 : -1))
      .slice(0, 6)
      .map((d) => ({ category: d.category, total: formatMoney(d.total) })),
  };
}

/** Compact text form for model context. Facts only; nothing here is a calculation the model must trust blindly. */
export function profileText(p: Profile): string {
  const lines = [
    `Account holder: ${p.holderNames.join(", ") || "unknown"}`,
    `Accounts: ${p.accounts.map((a) => `${a.name} (${a.balance}${a.asOf ? ` as of ${a.asOf}` : ""})`).join("; ") || "none"}`,
    `Months of data: ${p.monthsOfData}${p.dataFrom ? ` (transactions from ${p.dataFrom} to ${p.dataTo}; nothing after ${p.dataTo} has been imported yet, so "this month" may have no data)` : ""}`,
    p.monthly ? `Average month: income ${p.monthly.income}, spending ${p.monthly.spending}, net ${p.monthly.net}` : "",
    p.incomeSources.length ? `Income sources: ${p.incomeSources.map((s) => `${s.name} (${s.kind}, ${s.payments} payments${s.typicalDay ? `, usually around day ${s.typicalDay}` : ""})`).join("; ")}` : "",
    p.people.length ? `People and payees the user has labelled: ${p.people.map((x) => `${x.name} = ${x.label}`).join("; ")}` : "",
    p.commitments.length ? `Regular payments: ${p.commitments.map((c) => `${c.name} ${c.amount} (${c.category})`).join("; ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function monthsBetween(a: Date, b: Date) {
  const x = new Date(a.getTime() + 3600_000), y = new Date(b.getTime() + 3600_000);
  return (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + (y.getUTCMonth() - x.getUTCMonth());
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
