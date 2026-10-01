import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { seedDemoUser } from "@/core/demo";
import { ask } from "@/core/ask/answer";
import { parseQuestion } from "@/core/ask/intent";
import { onlyUsesFactNumbers } from "@/core/ask/llm";
import { monthPeriod } from "@/core/analytics";

const NOW = new Date("2026-09-26T12:00:00Z");

describe("intent parsing", () => {
  it.each([
    ["How much did I spend this month?", "spend_total"],
    ["How much did I spend on food in September?", "spend_category"],
    ["What did I spend the most on?", "spend_top_categories"],
    ["How much did I earn this month?", "income_total"],
    ["What were my largest incoming payments?", "income_largest"],
    ["What recurring income do I have?", "income_recurring"],
    ["Did I spend more this month than last month?", "compare"],
    ["Which categories increased?", "compare"],
    ["Show me transactions above ₦500,000", "transactions_above"],
    ["Find my biggest expenses", "largest_expenses"],
    ["Find all transfers to Oluwaseun", "sent_to"],
    ["How much did I receive from Pesa?", "received_from"],
    ["What subscriptions do I have?", "subscriptions"],
    ["What recurring payments do I have?", "recurring_payments"],
    ["How much cash do I have across all accounts?", "balance"],
    ["What's my average monthly burn?", "burn"],
    ["Tell me a joke", "unknown"],
  ])("%s -> %s", (q, kind) => {
    expect(parseQuestion(q, NOW).kind).toBe(kind);
  });

  it("parses thresholds with k/m suffixes", () => {
    const i = parseQuestion("show transactions above 1.5m", NOW);
    expect(i.kind === "transactions_above" && i.thresholdMinor).toBe(150_000_000n);
  });

  it("resolves month names to the most recent occurrence", () => {
    const i = parseQuestion("How much did I spend in December?", NOW);
    expect(i.kind === "spend_total" && i.period.label).toBe("December 2025");
  });
});

describe("answers come from the database, not model arithmetic", () => {
  let userId: string;
  beforeAll(async () => {
    const u = await db.user.create({ data: { email: "ask@test.dev", isDemo: true } });
    userId = u.id;
    await seedDemoUser(userId, NOW);
  });

  it("spend on food equals a direct SQL aggregate", async () => {
    const { facts } = await ask(userId, "How much did I spend on food this month?", NOW);
    const p = monthPeriod(NOW);
    const direct = await db.transaction.aggregate({
      where: { userId, type: "DEBIT", category: "Food", currency: "NGN", transactionDate: { gte: p.from, lt: p.to } },
      _sum: { amountMinor: true },
    });
    expect(facts.facts[0].minor).toBe(direct._sum.amountMinor!.toString());
    expect(BigInt(facts.facts[0].minor!)).toBeGreaterThan(0n);
  });

  it("income excludes own transfers and equals the sum of credits", async () => {
    const { facts } = await ask(userId, "How much did I earn this month?", NOW);
    const p = monthPeriod(NOW);
    const rows = await db.transaction.findMany({ where: { userId, type: "CREDIT", transactionDate: { gte: p.from, lt: p.to } } });
    const expected = rows.filter((r) => r.category !== "Own transfer").reduce((s, r) => s + r.amountMinor, 0n);
    expect(facts.facts[0].minor).toBe(expected.toString());
  });

  it("received from Pesa matches the ledger", async () => {
    const { facts } = await ask(userId, "How much did I receive from Pesa this year?", NOW);
    const rows = await db.transaction.findMany({ where: { userId, type: "CREDIT", description: { contains: "PESA" } } });
    const expected = rows.filter((r) => r.transactionDate.getUTCFullYear() === 2026).reduce((s, r) => s + r.amountMinor, 0n);
    expect(facts.facts[0].minor).toBe(expected.toString());
  });

  it("detects monthly subscriptions from history", async () => {
    const { facts } = await ask(userId, "What subscriptions do I have?", NOW);
    const labels = facts.facts.map((f) => f.label).join(" ");
    expect(labels).toContain("Netflix");
    expect(labels).toContain("Spotify");
  });

  it("transactions above threshold only returns larger rows", async () => {
    const { facts } = await ask(userId, "Show me transactions above ₦500,000 this month", NOW);
    expect(facts.rows!.length).toBeGreaterThan(0);
    const direct = await db.transaction.count({ where: { userId, amountMinor: { gt: 50_000_000n }, transactionDate: { gte: monthPeriod(NOW).from, lt: monthPeriod(NOW).to } } });
    expect(facts.rows!.length).toBe(Math.min(direct, 25));
  });

  it("compares a month in progress like-for-like", async () => {
    const { facts } = await ask(userId, "Did I spend more this month than last month?", NOW);
    expect(facts.period).toBe("September 2026 so far vs August 2026 (same days)");
    const p = monthPeriod(NOW);
    const prev = monthPeriod(NOW, -1);
    const sameDaysEnd = new Date(prev.from.getTime() + (NOW.getTime() - p.from.getTime()));
    const direct = await db.transaction.aggregate({
      where: { userId, type: "DEBIT", currency: "NGN", category: { not: "Own transfer" }, transactionDate: { gte: prev.from, lt: sameDaysEnd } },
      _sum: { amountMinor: true },
    });
    expect(facts.facts[1].minor).toBe((direct._sum.amountMinor ?? 0n).toString());
  });

  it("lookups without a period default to the last 12 months", () => {
    const i = parseQuestion("How much did I receive from Pesa?", NOW);
    expect(i.kind === "received_from" && i.period.label).toBe("the last 12 months");
  });

  it("guard rejects LLM text containing numbers that are not in the facts", async () => {
    const { facts } = await ask(userId, "How much did I spend this month?", NOW);
    const good = `You spent ${facts.facts[0].value} this month.`;
    expect(onlyUsesFactNumbers(good, facts)).toBe(true);
    expect(onlyUsesFactNumbers("You spent ₦123,456,789.00 this month.", facts)).toBe(false);
  });
});
