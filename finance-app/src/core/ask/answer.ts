import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import {
  BASE_CURRENCY, balances, incomeBySubcategory, largest, monthPeriod, recurring, spendingByCategory, summary, type Period,
} from "../analytics";
import { parseQuestion, type Intent } from "./intent";

// Question -> intent -> exact DB aggregates -> facts -> (optional) LLM phrasing.
// Facts are the source of truth. The LLM may only rephrase them.

export interface Fact {
  label: string;
  value: string; // pre-formatted from integer minor units
  minor?: string; // raw minor units as string, for tests and audit
}

export interface FactRow {
  date: string;
  description: string;
  category: string;
  amount: string;
  type: string;
}

export interface Facts {
  intent: Intent["kind"];
  period?: string;
  headline: string; // deterministic answer built from facts
  facts: Fact[];
  rows?: FactRow[];
}

const fmt = (minor: bigint) => formatMoney(minor, BASE_CURRENCY);
const fact = (label: string, minor: bigint): Fact => ({ label, value: fmt(minor), minor: minor.toString() });
const lagosDate = (d: Date) => new Date(d.getTime() + 3600_000).toISOString().slice(0, 10);

function toRows(txs: { transactionDate: Date; description: string; category: string; amountMinor: bigint; type: string; currency: string }[]): FactRow[] {
  return txs.map((t) => ({
    date: lagosDate(t.transactionDate),
    description: t.description,
    category: t.category,
    amount: formatMoney(t.amountMinor, t.currency),
    type: t.type,
  }));
}

async function sumWhere(userId: string, p: Period, where: object) {
  const r = await db.transaction.aggregate({
    where: { userId, currency: BASE_CURRENCY, transactionDate: { gte: p.from, lt: p.to }, ...where },
    _sum: { amountMinor: true },
    _count: true,
  });
  return { total: r._sum.amountMinor ?? 0n, count: r._count };
}

export async function computeFacts(userId: string, intent: Intent, now = new Date()): Promise<Facts> {
  switch (intent.kind) {
    case "spend_total": {
      const s = await summary(userId, intent.period);
      return {
        intent: intent.kind, period: intent.period.label,
        headline: `You spent ${fmt(s.expenses)} across ${s.expenseCount} debits in ${intent.period.label}.`,
        facts: [fact("Total spent", s.expenses), fact("Total received", s.income)],
      };
    }
    case "spend_category": {
      const r = await sumWhere(userId, intent.period, { type: "DEBIT", category: intent.category });
      return {
        intent: intent.kind, period: intent.period.label,
        headline: `You spent ${fmt(r.total)} on ${intent.category} in ${intent.period.label} (${r.count} transactions).`,
        facts: [fact(`${intent.category} spend`, r.total)],
      };
    }
    case "spend_top_categories": {
      const cats = await spendingByCategory(userId, intent.period);
      const top = cats[0];
      return {
        intent: intent.kind, period: intent.period.label,
        headline: top ? `Your biggest category in ${intent.period.label} was ${top.category} at ${fmt(top.total)}.` : `No spending recorded in ${intent.period.label}.`,
        facts: cats.slice(0, 6).map((c) => fact(c.category, c.total)),
      };
    }
    case "income_total": {
      const s = await summary(userId, intent.period);
      const subs = await incomeBySubcategory(userId, intent.period);
      return {
        intent: intent.kind, period: intent.period.label,
        headline: `You received ${fmt(s.income)} in ${intent.period.label} across ${s.incomeCount} credits.`,
        facts: [fact("Total income", s.income), ...subs.map((x) => fact(x.subcategory, x.total))],
      };
    }
    case "income_largest": {
      const txs = await largest(userId, intent.period, "CREDIT", 5);
      return {
        intent: intent.kind, period: intent.period.label,
        headline: txs[0] ? `Your largest incoming payment in ${intent.period.label} was ${fmt(txs[0].amountMinor)}.` : `No income recorded in ${intent.period.label}.`,
        facts: txs.slice(0, 1).map((t) => fact("Largest credit", t.amountMinor)),
        rows: toRows(txs),
      };
    }
    case "income_recurring": {
      const items = await recurring(userId, now, "CREDIT");
      return {
        intent: intent.kind,
        headline: items.length ? `You have ${items.length} recurring income source${items.length > 1 ? "s" : ""}.` : "No recurring income detected yet. It needs at least two months of history.",
        facts: items.map((i) => fact(`${i.name} (avg, ${i.occurrences}x)`, i.averageMinor)),
      };
    }
    case "received_from":
    case "sent_to": {
      const type = intent.kind === "received_from" ? "CREDIT" : "DEBIT";
      const name = intent.name;
      const txs = await db.transaction.findMany({
        where: {
          userId, type, currency: BASE_CURRENCY,
          transactionDate: { gte: intent.period.from, lt: intent.period.to },
          OR: [{ description: { contains: name } }, { merchantName: { contains: name } }, { counterparty: { contains: name } },
            { description: { contains: name.toUpperCase() } }],
        },
        orderBy: { transactionDate: "desc" },
      });
      const total = txs.reduce((s, t) => s + t.amountMinor, 0n);
      const verb = type === "CREDIT" ? "received from" : "sent to";
      return {
        intent: intent.kind, period: intent.period.label,
        headline: txs.length ? `You ${verb} ${name} ${fmt(total)} in ${intent.period.label} (${txs.length} transactions).` : `No transactions ${verb} "${name}" in ${intent.period.label}.`,
        facts: [fact(`Total ${verb} ${name}`, total)],
        rows: toRows(txs.slice(0, 10)),
      };
    }
    case "compare": {
      // Month in progress: compare like-for-like against the same number of days last month.
      const partial = intent.current.to > now && intent.current.from <= now;
      const elapsed = now.getTime() - intent.current.from.getTime();
      const prevWindow: Period = partial
        ? { from: intent.previous.from, to: new Date(Math.min(intent.previous.from.getTime() + elapsed, intent.previous.to.getTime())), label: `${intent.previous.label} (same days)` }
        : intent.previous;
      const curLabel = partial ? `${intent.current.label} so far` : intent.current.label;
      const [a, b, bFull, ca, cb] = await Promise.all([
        summary(userId, intent.current), summary(userId, prevWindow), summary(userId, intent.previous),
        spendingByCategory(userId, intent.current), spendingByCategory(userId, prevWindow),
      ]);
      const diff = a.expenses - b.expenses;
      const prev = new Map(cb.map((c) => [c.category, c.total]));
      const changes = ca
        .map((c) => ({ category: c.category, delta: c.total - (prev.get(c.category) ?? 0n) }))
        .filter((c) => c.delta > 0n)
        .sort((x, y) => (y.delta > x.delta ? 1 : -1))
        .slice(0, 4);
      const dir = diff > 0n ? "more" : "less";
      return {
        intent: intent.kind, period: `${curLabel} vs ${prevWindow.label}`,
        headline: diff === 0n
          ? `You spent the same in ${curLabel} as in ${prevWindow.label}.`
          : `You spent ${fmt(diff < 0n ? -diff : diff)} ${dir} in ${curLabel} than in ${prevWindow.label}.${changes[0] ? ` The biggest increase was ${changes[0].category}.` : ""}`,
        facts: [
          fact(`Spent ${curLabel}`, a.expenses), fact(`Spent ${prevWindow.label}`, b.expenses),
          ...(partial ? [fact(`Spent ${intent.previous.label} (full month)`, bFull.expenses)] : []),
          fact(`Income ${curLabel}`, a.income), fact(`Income ${prevWindow.label}`, b.income),
          ...changes.map((c) => fact(`${c.category} increase`, c.delta)),
        ],
      };
    }
    case "transactions_above": {
      const txs = await db.transaction.findMany({
        where: { userId, currency: BASE_CURRENCY, amountMinor: { gt: intent.thresholdMinor }, transactionDate: { gte: intent.period.from, lt: intent.period.to } },
        orderBy: { amountMinor: "desc" },
        take: 25,
      });
      return {
        intent: intent.kind, period: intent.period.label,
        headline: `${txs.length} transaction${txs.length === 1 ? "" : "s"} above ${fmt(intent.thresholdMinor)} in ${intent.period.label}.`,
        facts: [fact("Threshold", intent.thresholdMinor)],
        rows: toRows(txs),
      };
    }
    case "largest_expenses": {
      const txs = await largest(userId, intent.period, "DEBIT", 5);
      return {
        intent: intent.kind, period: intent.period.label,
        headline: txs[0] ? `Your biggest expense in ${intent.period.label} was ${fmt(txs[0].amountMinor)} (${txs[0].merchantName ?? txs[0].description}).` : `No expenses in ${intent.period.label}.`,
        facts: txs.slice(0, 1).map((t) => fact("Largest debit", t.amountMinor)),
        rows: toRows(txs),
      };
    }
    case "subscriptions":
    case "recurring_payments": {
      const all = await recurring(userId, now, "DEBIT");
      const items = intent.kind === "subscriptions" ? all.filter((i) => i.category === "Subscriptions" || i.category === "Utilities") : all;
      const monthly = items.reduce((s, i) => s + i.averageMinor, 0n);
      const noun = intent.kind === "subscriptions" ? "subscription" : "recurring payment";
      return {
        intent: intent.kind,
        headline: items.length ? `You have ${items.length} ${noun}${items.length > 1 ? "s" : ""} totalling about ${fmt(monthly)} a month.` : `No ${noun}s detected yet. Detection needs at least two months of history.`,
        facts: [fact("Estimated monthly total", monthly), ...items.map((i) => fact(`${i.name} (${i.category})`, i.averageMinor))],
      };
    }
    case "balance": {
      const b = await balances(userId);
      return {
        intent: intent.kind,
        headline: b.accounts.length ? `Your latest known ${BASE_CURRENCY} balance across ${b.accounts.filter((a) => a.currency === BASE_CURRENCY).length} account(s) is ${fmt(b.totalBase)}, taken from the most recent alert.` : "No accounts connected yet.",
        facts: [fact(`Total ${BASE_CURRENCY} balance`, b.totalBase), ...b.accounts.map((a) => ({ label: a.accountName, value: formatMoney(a.balanceMinor ?? 0n, a.currency), minor: (a.balanceMinor ?? 0n).toString() }))],
      };
    }
    case "burn": {
      const periods = [1, 2, 3].map((i) => monthPeriod(now, -i));
      const sums = await Promise.all(periods.map((p) => summary(userId, p)));
      const avg = sums.reduce((s, x) => s + x.expenses, 0n) / 3n;
      return {
        intent: intent.kind, period: `${periods[2].label} to ${periods[0].label}`,
        headline: `Your average monthly burn over the last 3 full months is ${fmt(avg)}.`,
        facts: [fact("Average monthly spend", avg), ...periods.map((p, i) => fact(p.label, sums[i].expenses))],
      };
    }
    default:
      return {
        intent: "unknown",
        headline: "I can answer questions about spending, income, categories, comparisons, large transactions, transfers, subscriptions, recurring payments, balance and burn. Try one of the suggestions.",
        facts: [],
      };
  }
}

export const SUGGESTED_QUESTIONS = [
  "How much did I spend this month?",
  "What did I spend the most on?",
  "How much did I spend on food?",
  "How much did I earn this month?",
  "Did I spend more this month than last month?",
  "Show me transactions above ₦500,000",
  "How much did I receive from Pesa?",
  "What subscriptions do I have?",
  "What recurring payments do I have?",
  "What's my average monthly burn?",
  "How much cash do I have?",
];

export async function ask(userId: string, question: string, now = new Date()) {
  const intent = parseQuestion(question, now);
  const facts = await computeFacts(userId, intent, now);
  return { intent, facts };
}
