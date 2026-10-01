import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { formatMoney, parseAmountToMinor } from "@/lib/money";
import { log } from "@/lib/log";
import {
  BASE_CURRENCY, balances, incomeSources, listTransactions, recurring, spendingByCategory, summary, type Period,
} from "../analytics";
import { ALL_CATEGORIES, sameName } from "../categorize";
import { parsePeriod } from "../ask/intent";
import { buildProfile, profileText } from "../profile";
import { FALLBACK, MODEL, anthropic, redactNarration } from "./client";

// The personal finance assistant. Claude decides WHAT to look up; these tools compute every number
// from the user's ledger (scoped to the signed-in user). Claude is told to quote tool numbers only,
// and a guard rejects any answer containing a figure that no tool returned.

type Tool = Anthropic.Beta.BetaTool;
type MessageParam = Anthropic.Beta.BetaMessageParam;

const periodProp = {
  type: "string",
  description: 'Natural period, e.g. "this month", "last month", "September 2026", "last 3 months", "this year", "last 30 days".',
} as const;

export const TOOLS: Tool[] = [
  { name: "get_period_summary", description: "Income, spending and net for a period (own-account transfers excluded).", input_schema: { type: "object", properties: { period: periodProp }, required: ["period"], additionalProperties: false } },
  { name: "spending_by_category", description: "Spending per category for a period, largest first.", input_schema: { type: "object", properties: { period: periodProp }, required: ["period"], additionalProperties: false } },
  { name: "income_sources", description: "Who paid the user in a period and how much.", input_schema: { type: "object", properties: { period: periodProp }, required: ["period"], additionalProperties: false } },
  {
    name: "find_transactions",
    description: "Search transactions. Returns matching rows (newest first, up to limit) plus the exact total and count of ALL matches.",
    input_schema: {
      type: "object",
      properties: {
        period: { ...periodProp, description: `${periodProp.description} Use "all time" for no date filter.` },
        text: { type: "string", description: "Words to find in the description, payee or reference. Empty for none." },
        category: { type: "string", enum: ["", ...ALL_CATEGORIES] },
        direction: { type: "string", enum: ["any", "in", "out"] },
        min_naira: { type: "number", description: "Minimum amount in naira, 0 for none." },
        limit: { type: "integer", description: "Rows to return, 1 to 25." },
      },
      required: ["period", "text", "category", "direction", "min_naira", "limit"],
      additionalProperties: false,
    },
  },
  {
    name: "compare_periods",
    description: "Compares two periods: income, spending and per-category differences, computed exactly.",
    input_schema: { type: "object", properties: { period_a: periodProp, period_b: periodProp }, required: ["period_a", "period_b"], additionalProperties: false },
  },
  {
    name: "person_summary",
    description: "Everything sent to and received from one person or business across all time, by month. Names match in any word order.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
  },
  {
    name: "recurring_payments",
    description: "Payments or income that repeat roughly monthly.",
    input_schema: { type: "object", properties: { direction: { type: "string", enum: ["out", "in"] } }, required: ["direction"], additionalProperties: false },
  },
  { name: "balances", description: "Latest known balance per account and the naira total.", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
  { name: "profile", description: "What is known about the user: accounts, income sources, people they have labelled, regular payments, monthly averages.", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
].map((t) => ({ ...t, strict: true }) as Tool);

const money = (m: bigint, cur = BASE_CURRENCY) => formatMoney(m, cur);

function resolvePeriod(text: string, now: Date): Period | undefined {
  if (/all ?time|ever|everything/i.test(text)) return undefined;
  return parsePeriod(text, now);
}

/** Runs one tool for one user. Every figure is formatted here, so the model never has to do arithmetic. */
export async function runTool(userId: string, name: string, input: Record<string, unknown>, now = new Date()): Promise<unknown> {
  const P = (k: string) => parsePeriod(String(input[k] ?? "this month"), now);
  switch (name) {
    case "get_period_summary": {
      const p = P("period");
      const s = await summary(userId, p);
      return { period: p.label, income: money(s.income), spending: money(s.expenses), net: money(s.net), credits: s.incomeCount, debits: s.expenseCount };
    }
    case "spending_by_category": {
      const p = P("period");
      return { period: p.label, categories: (await spendingByCategory(userId, p)).map((c) => ({ category: c.category, total: money(c.total), transactions: c.count })) };
    }
    case "income_sources": {
      const p = P("period");
      return { period: p.label, sources: (await incomeSources(userId, p, 15)).map((s) => ({ from: s.name, kind: s.kind, total: money(s.total), payments: s.count })) };
    }
    case "find_transactions": {
      const p = resolvePeriod(String(input.period ?? "all time"), now);
      const dir = input.direction === "in" ? "CREDIT" : input.direction === "out" ? "DEBIT" : undefined;
      const min = Number(input.min_naira) > 0 ? parseAmountToMinor(String(input.min_naira)) ?? undefined : undefined;
      const category = ALL_CATEGORIES.includes(String(input.category)) ? String(input.category) : undefined;
      const text = String(input.text ?? "").trim().slice(0, 60) || undefined;
      const filters = { from: p?.from, to: p?.to, type: dir as "DEBIT" | "CREDIT" | undefined, category, q: text, minMinor: min };
      const limit = Math.max(1, Math.min(25, Number(input.limit) || 10));
      const page = await listTransactions(userId, filters, 1, limit);
      const all = await listTransactions(userId, filters, 1, 5000);
      const total = all.rows.reduce((s, r) => s + r.amountMinor, 0n);
      return {
        period: p?.label ?? "all time",
        matches: all.total,
        total_of_matches: money(total),
        rows: page.rows.map((r) => ({
          date: new Date(r.transactionDate.getTime() + 3600_000).toISOString().slice(0, 10),
          direction: r.type === "CREDIT" ? "in" : "out",
          amount: money(r.amountMinor, r.currency),
          payee: r.merchantName ?? r.counterparty ?? null,
          category: r.category,
          subcategory: r.subcategory,
          description: redactNarration(r.description).slice(0, 90),
        })),
      };
    }
    case "compare_periods": {
      const a = P("period_a"), b = P("period_b");
      const [sa, sb, ca, cb] = await Promise.all([summary(userId, a), summary(userId, b), spendingByCategory(userId, a), spendingByCategory(userId, b)]);
      const cats = new Map<string, { a: bigint; b: bigint }>();
      for (const c of ca) cats.set(c.category, { a: c.total, b: 0n });
      for (const c of cb) cats.set(c.category, { a: cats.get(c.category)?.a ?? 0n, b: c.total });
      return {
        period_a: a.label, period_b: b.label,
        income: { a: money(sa.income), b: money(sb.income), change: money(sa.income - sb.income) },
        spending: { a: money(sa.expenses), b: money(sb.expenses), change: money(sa.expenses - sb.expenses) },
        by_category: [...cats.entries()]
          .map(([category, v]) => ({ category, a: money(v.a), b: money(v.b), change: money(v.a - v.b), _d: v.a - v.b }))
          .sort((x, y) => (y._d > x._d ? 1 : -1))
          .map(({ _d, ...rest }) => (void _d, rest)),
      };
    }
    case "person_summary": {
      const name = String(input.name ?? "").trim();
      const rows = await db.transaction.findMany({ where: { userId }, select: { type: true, amountMinor: true, counterparty: true, merchantName: true, description: true, transactionDate: true, category: true, subcategory: true } });
      const hits = rows.filter((r) => sameName(r.counterparty ?? "", name) || sameName(r.merchantName ?? "", name) || (name.length >= 4 && (r.counterparty ?? r.merchantName ?? "").toLowerCase().includes(name.toLowerCase())));
      const months = new Map<string, { out: bigint; in: bigint }>();
      for (const r of hits) {
        const k = new Date(r.transactionDate.getTime() + 3600_000).toISOString().slice(0, 7);
        const m = months.get(k) ?? { out: 0n, in: 0n };
        if (r.type === "DEBIT") m.out += r.amountMinor;
        else m.in += r.amountMinor;
        months.set(k, m);
      }
      const out = hits.filter((r) => r.type === "DEBIT").reduce((s, r) => s + r.amountMinor, 0n);
      const inn = hits.filter((r) => r.type === "CREDIT").reduce((s, r) => s + r.amountMinor, 0n);
      return {
        name, transactions: hits.length, total_sent: money(out), total_received: money(inn),
        labels: [...new Set(hits.map((h) => [h.category, h.subcategory].filter(Boolean).join(" / ")))],
        by_month: [...months.entries()].sort().map(([month, v]) => ({ month, sent: money(v.out), received: money(v.in) })),
      };
    }
    case "recurring_payments": {
      const items = await recurring(userId, now, input.direction === "in" ? "CREDIT" : "DEBIT", 12);
      return { items: items.map((r) => ({ name: r.name, category: r.category, typical_amount: money(r.averageMinor), times_seen: r.occurrences, next_around: r.nextExpected.toISOString().slice(0, 10) })) };
    }
    case "balances": {
      const b = await balances(userId);
      return { total_naira: money(b.totalBase), accounts: b.accounts.map((a) => ({ account: a.accountName, balance: money(a.balanceMinor ?? 0n, a.currency), as_of: a.balanceUpdatedAt?.toISOString().slice(0, 10) ?? null })) };
    }
    case "profile":
      return buildProfile(userId, now);
    default:
      return { error: `unknown tool ${name}` };
  }
}

/** Figures in an answer must come from tool results (or the user's own question). */
export function numbersNotFromTools(answer: string, toolText: string, question: string): string[] {
  const norm = (n: string) => n.replace(/,/g, "").replace(/\.0+$/, "");
  const allowed = new Set((`${toolText} ${question}`.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(norm));
  // Compact forms the model may use for tool values: "₦1.98M" from "₦1,983,611.00"
  for (const n of [...allowed]) {
    const v = Number(n);
    if (v >= 1_000_000) {
      allowed.add(String(Math.round(v / 10_000) / 100));
      allowed.add(String(Math.round(v / 100_000) / 10));
    }
    if (v >= 1_000) {
      allowed.add(String(Math.round(v / 100) / 10));
      allowed.add(String(Math.round(v / 1000)));
    }
  }
  return (answer.match(/\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map(norm)
    // Small numbers are counts, days or ordinals in prose; amounts are what matter.
    .filter((n) => Number(n) >= 100 && !/^(19|20)\d\d$/.test(n))
    .filter((n) => !allowed.has(n));
}

export interface AssistantTurn { role: "user" | "assistant"; text: string }
export interface ToolCallLog { tool: string; input: unknown; output: unknown }
export interface AssistantReply { text: string; toolCalls: ToolCallLog[]; grounded: boolean }

/** The model call, injectable so tests run without a network. */
export type CreateMessage = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;

const defaultCreate: CreateMessage = (params) => anthropic().beta.messages.create(params);

function systemPrompt(profile: string, now: Date) {
  return `You are Ledger, a personal finance assistant for one person in Nigeria. Today is ${now.toISOString().slice(0, 10)}.
Answer from the user's own ledger using the tools. Every amount, count and date in your answer must come from a tool result in this conversation; never estimate, round in your head, add up or invent figures. If you need a total or a difference, call a tool that returns it (find_transactions returns total_of_matches; compare_periods returns changes).
Be warm and brief: lead with the answer in one or two sentences, then up to three short supporting points if useful. Use naira amounts exactly as tools format them. If the data cannot answer the question, say what is missing.
You can explain and summarise. You do not give personalised investment advice; if asked, say you are not a licensed adviser. You cannot move money.
What you already know about this person:
${profile}`;
}

export async function askAssistant(
  userId: string,
  question: string,
  history: AssistantTurn[] = [],
  opts: { create?: CreateMessage; now?: Date; maxSteps?: number } = {},
): Promise<AssistantReply> {
  const now = opts.now ?? new Date();
  const create = opts.create ?? defaultCreate;
  const system = systemPrompt(profileText(await buildProfile(userId, now)), now);
  const messages: MessageParam[] = [
    ...history.slice(-6).map((t) => ({ role: t.role, content: t.text }) as MessageParam),
    { role: "user", content: question },
  ];
  const toolCalls: ToolCallLog[] = [];
  let retriedForGrounding = false;

  for (let step = 0; step < (opts.maxSteps ?? 8); step++) {
    const res = await create({
      model: MODEL,
      max_tokens: 16000,
      ...FALLBACK,
      output_config: { effort: "low" },
      system,
      tools: TOOLS,
      messages,
    });
    if (res.stop_reason === "refusal") return { text: "I can't help with that one.", toolCalls, grounded: true };

    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (res.stop_reason === "tool_use" && uses.length) {
      messages.push({ role: "assistant", content: res.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        try {
          const output = await runTool(userId, u.name, (u.input ?? {}) as Record<string, unknown>, now);
          toolCalls.push({ tool: u.name, input: u.input, output });
          results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(output, (_, v) => (typeof v === "bigint" ? v.toString() : v)) });
        } catch (e) {
          log.warn("assistant.tool_error", { tool: u.name, error: e instanceof Error ? e.message : "unknown" });
          results.push({ type: "tool_result", tool_use_id: u.id, content: "Tool failed.", is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    const toolText = JSON.stringify(toolCalls.map((t) => t.output), (_, v) => (typeof v === "bigint" ? v.toString() : v));
    const stray = numbersNotFromTools(text, toolText, question);
    if (!stray.length) return { text, toolCalls, grounded: true };
    if (!retriedForGrounding) {
      retriedForGrounding = true;
      messages.push({ role: "assistant", content: res.content });
      messages.push({ role: "user", content: `These figures in your answer did not come from a tool result: ${stray.join(", ")}. Answer again using only figures returned by tools (call a tool if you need a total or a difference).` });
      continue;
    }
    log.warn("assistant.ungrounded", { userId, stray: stray.length });
    return { text, toolCalls, grounded: false };
  }
  return { text: "That took too many steps. Try asking a more specific question.", toolCalls, grounded: true };
}
