import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { importStatement } from "@/core/statement-import";
import { askAssistant, numbersNotFromTools, runTool, TOOLS, type CreateMessage } from "@/core/ai/assistant";

const NOW = new Date("2026-10-01T12:00:00Z");
const STATEMENT = Buffer.from([
  "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
  "01-Sep-2026,R1,,1500000.00,1600000.00,W5WM-MONIE MFB-DEEL INC",
  "04-Sep-2026,R4,45000.00,,1555000.00,POS PURCHASE SHOPRITE LEKKI",
  "05-Sep-2026,R5,80000.00,,1475000.00,Instant Payment Outward 0903 Y TO KUDA - AMAKA OBI",
  "20-Sep-2026,R6,20000.00,,1455000.00,Instant Payment Outward 0904 Y TO KUDA - OBI AMAKA",
].join("\n"));

function msg(content: unknown[], stop: string): Anthropic.Beta.BetaMessage {
  return { id: "m", type: "message", role: "assistant", model: "x", content, stop_reason: stop, stop_sequence: null, usage: {} } as unknown as Anthropic.Beta.BetaMessage;
}
const toolUse = (name: string, input: unknown, id = "t1") => ({ type: "tool_use", id, name, input });
const text = (t: string) => ({ type: "text", text: t });

async function user(email: string) {
  const u = await db.user.create({ data: { email } });
  await importStatement(u.id, { name: "s.csv", bytes: STATEMENT }, { institution: "GTBank" });
  return u.id;
}

describe("assistant tools", () => {
  it("compute exact figures for the signed-in user only", async () => {
    const a = await user("asst-a@test.dev");
    const b = await db.user.create({ data: { email: "asst-b@test.dev" } });
    const s = (await runTool(a, "get_period_summary", { period: "September 2026" }, NOW)) as Record<string, string>;
    expect(s).toMatchObject({ income: "₦1,500,000.00", spending: "₦145,000.00" });
    expect(((await runTool(b.id, "get_period_summary", { period: "September 2026" }, NOW)) as Record<string, string>).income).toBe("₦0.00");
    const p = (await runTool(a, "person_summary", { name: "Amaka Obi" }, NOW)) as Record<string, unknown>;
    expect(p).toMatchObject({ transactions: 2, total_sent: "₦100,000.00" }); // both spellings
    const f = (await runTool(a, "find_transactions", { period: "all time", text: "", category: "", direction: "out", min_naira: 30000, limit: 1 }, NOW)) as Record<string, unknown>;
    expect(f).toMatchObject({ matches: 2, total_of_matches: "₦125,000.00" });
    expect((f.rows as unknown[]).length).toBe(1);
  });

  it("all tools are strict with closed schemas", () => {
    for (const t of TOOLS) {
      expect(t).toMatchObject({ strict: true });
      expect((t as unknown as { input_schema: { additionalProperties: boolean } }).input_schema.additionalProperties).toBe(false);
    }
  });
});

describe("assistant loop", () => {
  it("calls tools, then answers with tool figures", async () => {
    const userId = await user("asst-c@test.dev");
    const script = [
      msg([toolUse("get_period_summary", { period: "September 2026" })], "tool_use"),
      msg([text("In September 2026 you received ₦1,500,000.00 and spent ₦145,000.00.")], "end_turn"),
    ];
    const calls: unknown[] = [];
    const create: CreateMessage = async (p) => (calls.push(p), script.shift()!);
    const r = await askAssistant(userId, "How did September go?", [], { create, now: NOW });
    expect(r).toMatchObject({ grounded: true, text: "In September 2026 you received ₦1,500,000.00 and spent ₦145,000.00." });
    expect(r.toolCalls[0].tool).toBe("get_period_summary");
    expect(calls).toHaveLength(2);
    // Server-side refusal fallback enabled on every call
    expect(calls[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
  });

  it("catches an invented figure, asks again, and accepts the grounded retry", async () => {
    const userId = await user("asst-d@test.dev");
    const script = [
      msg([toolUse("get_period_summary", { period: "September 2026" })], "tool_use"),
      msg([text("You spent about ₦150,000 in September.")], "end_turn"),
      msg([text("You spent ₦145,000.00 in September 2026.")], "end_turn"),
    ];
    const seen: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
    const create: CreateMessage = async (p) => (seen.push(structuredClone(p)), script.shift()!);
    const r = await askAssistant(userId, "How much did I spend in September?", [], { create, now: NOW });
    expect(r).toMatchObject({ grounded: true, text: "You spent ₦145,000.00 in September 2026." });
    expect(JSON.stringify(seen[2].messages.at(-1))).toContain("150000");
  });

  it("flags an answer that stays ungrounded", async () => {
    const userId = await user("asst-e@test.dev");
    const script = [msg([text("You have ₦9,999,999.")], "end_turn"), msg([text("Still ₦9,999,999.")], "end_turn")];
    const r = await askAssistant(userId, "balance?", [], { create: async () => script.shift()!, now: NOW });
    expect(r.grounded).toBe(false);
  });

  it("number guard ignores small counts and years, allows compact forms of tool values", () => {
    expect(numbersNotFromTools("3 payments in 2026, about ₦1.98M", '{"total":"₦1,983,611.00"}', "")).toEqual([]);
    expect(numbersNotFromTools("₦250,000", '{"total":"₦1,983,611.00"}', "")).toEqual(["250000"]);
  });
});
