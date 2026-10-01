import { EXPENSE_CATEGORIES } from "../categorize";
import { monthPeriod, specificMonth, type Period } from "../analytics";
import { parseAmountToMinor } from "@/lib/money";

// Deterministic intent parsing. No LLM is involved in deciding what to compute.

export type Intent =
  | { kind: "spend_total"; period: Period }
  | { kind: "spend_category"; period: Period; category: string }
  | { kind: "spend_top_categories"; period: Period }
  | { kind: "income_total"; period: Period }
  | { kind: "income_largest"; period: Period }
  | { kind: "income_recurring" }
  | { kind: "received_from"; period: Period; name: string }
  | { kind: "sent_to"; period: Period; name: string }
  | { kind: "compare"; current: Period; previous: Period }
  | { kind: "transactions_above"; period: Period; thresholdMinor: bigint }
  | { kind: "largest_expenses"; period: Period }
  | { kind: "subscriptions" }
  | { kind: "recurring_payments" }
  | { kind: "balance" }
  | { kind: "burn" }
  | { kind: "unknown" };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const CATEGORY_WORDS: Record<string, string> = {
  food: "Food", groceries: "Food", eating: "Food", restaurants: "Food",
  transport: "Transport", uber: "Transport", bolt: "Transport", rides: "Transport", fuel: "Transport",
  rent: "Housing", housing: "Housing",
  utilities: "Utilities", electricity: "Utilities", airtime: "Utilities", data: "Utilities",
  shopping: "Shopping", subscriptions: "Subscriptions", family: "Family", debt: "Debt", loans: "Debt",
  health: "Healthcare", healthcare: "Healthcare", travel: "Travel", business: "Business",
  transfers: "Transfers", fees: "Fees", charges: "Fees",
};

export function parsePeriod(q: string, now: Date): Period {
  const s = q.toLowerCase();
  if (/last month|previous month/.test(s)) return monthPeriod(now, -1);
  const days = s.match(/(?:last|past) (\d{1,3}) days/);
  if (days) {
    const to = now;
    return { from: new Date(now.getTime() - +days[1] * 86400_000), to: new Date(to.getTime() + 1), label: `the last ${days[1]} days` };
  }
  const months = s.match(/(?:last|past) (\d{1,2}) months/);
  if (months) {
    const p = monthPeriod(now, -(+months[1] - 1));
    return { from: p.from, to: monthPeriod(now, 0).to, label: `the last ${months[1]} months` };
  }
  if (/this year|year to date|ytd/.test(s)) {
    const y = new Date(now.getTime() + 3600_000).getUTCFullYear();
    return { from: new Date(Date.UTC(y, 0, 1) - 3600_000), to: new Date(Date.UTC(y + 1, 0, 1) - 3600_000), label: `${y}` };
  }
  const m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b(?:\s+(\d{4}))?/);
  if (m) {
    const idx = MONTHS.indexOf(m[1]);
    const local = new Date(now.getTime() + 3600_000);
    let year = m[2] ? +m[2] : local.getUTCFullYear();
    if (!m[2] && idx > local.getUTCMonth()) year -= 1;
    return specificMonth(year, idx);
  }
  return monthPeriod(now, 0);
}

const EXPLICIT_PERIOD = /this month|last month|previous month|(last|past) \d+ (days|months)|this year|year to date|ytd|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/;

/** Lookups ("received from X", "above N") default to the last 12 months rather than this month. */
function lookupPeriod(s: string, now: Date): Period {
  if (EXPLICIT_PERIOD.test(s)) return parsePeriod(s, now);
  const p = monthPeriod(now, -11);
  return { from: p.from, to: monthPeriod(now, 0).to, label: "the last 12 months" };
}

function findCategory(s: string): string | undefined {
  for (const c of EXPENSE_CATEGORIES) if (new RegExp(`\\b${c.toLowerCase()}\\b`).test(s)) return c;
  for (const [w, c] of Object.entries(CATEGORY_WORDS)) if (new RegExp(`\\b${w}\\b`).test(s)) return c;
  return undefined;
}

function parseThreshold(s: string): bigint | undefined {
  const m = s.match(/(?:above|over|more than|greater than|>)\s*(?:₦|ngn|n)?\s*([\d,.]+)\s*(k|m|million|thousand)?/i);
  if (!m) return undefined;
  const base = parseAmountToMinor(m[1].replace(/,/g, ""));
  if (base === null) return undefined;
  const mult = m[2]?.toLowerCase();
  if (mult === "k" || mult === "thousand") return base * 1000n;
  if (mult === "m" || mult === "million") return base * 1_000_000n;
  return base;
}

function extractName(q: string, after: RegExp): string | undefined {
  const m = q.match(after);
  if (!m) return undefined;
  return m[1]
    .replace(/\b(this|last|in|during|for)\b.*$/i, "")
    .replace(/[?.!]+$/, "")
    .trim() || undefined;
}

export function parseQuestion(question: string, now = new Date()): Intent {
  const s = question.toLowerCase().trim();
  const period = parsePeriod(s, now);
  const lookup = lookupPeriod(s, now);

  if (/subscription/.test(s)) return { kind: "subscriptions" };
  if (/recurring (income|payments? in)|repeat(ing)? income/.test(s)) return { kind: "income_recurring" };
  if (/recurring|repeat|bills? .*monthly|monthly bills/.test(s)) return { kind: "recurring_payments" };
  if (/burn|average monthly (spend|expense)/.test(s)) return { kind: "burn" };
  if (/(balance|how much (cash|money) do i have)/.test(s)) return { kind: "balance" };

  const threshold = parseThreshold(s);
  if (threshold !== undefined && /transaction|payment|show|find|list/.test(s)) return { kind: "transactions_above", period: lookup, thresholdMinor: threshold };

  if (/(compare|than last month|than the previous month|increase|decrease|changed|vs\.? last month)/.test(s)) {
    const current = parsePeriod(s.replace(/last month|previous month/g, ""), now);
    const previous = monthPeriod(new Date(current.from.getTime() + 3600_000), -1);
    return { kind: "compare", current, previous };
  }

  const from = extractName(question, /(?:receive|received|get|got|earn|earned)\s+from\s+(.+)/i);
  if (from) return { kind: "received_from", period: lookup, name: from };
  const to = extractName(question, /(?:transfers?|sent|send|paid|pay)\s+to\s+(.+)/i);
  if (to) return { kind: "sent_to", period: lookup, name: to };

  if (/(largest|biggest|top) (incoming|income|payments? (in|received)|credits?)/.test(s)) return { kind: "income_largest", period };
  if (/(earn|income|receive|received|made|salary)/.test(s)) return { kind: "income_total", period };
  if (/(largest|biggest|top) (expense|spend|purchase|payment|debit)/.test(s)) return { kind: "largest_expenses", period };
  if (/spen[dt] the most|biggest categor|top categor|where did my money go|breakdown/.test(s)) return { kind: "spend_top_categories", period };

  if (/(spen[dt]|expense|cost|pay|paid|outflow)/.test(s)) {
    const category = findCategory(s);
    return category ? { kind: "spend_category", period, category } : { kind: "spend_total", period };
  }
  return { kind: "unknown" };
}
