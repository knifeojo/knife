import { afterEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { issueSession } from "@/lib/auth";
import { importStatement } from "@/core/statement-import";
import { loadAffordabilityData } from "@/core/affordability";
import { ask } from "@/core/ask/answer";
import { aiConfig, aiRouting, anthropic, setUserPrefs, type AiConfig } from "@/core/ai/client";
import { AiUnavailableError, type Fetch } from "@/core/ai/ollama";
import { cloudCategorizeLLM, needsSecondOpinion, suggestCategories, type CategorizeLLM, type Categorizer } from "@/core/ai/categorizer";
import { chatForUser, phraseForUser } from "@/core/ai/router";
import { parseSuggestArgs, runSuggestCli } from "@/core/ai/batch";
import { redactorFor } from "@/core/ai/redact";
import { GET as aiGet, POST as aiPost } from "@/app/api/v1/ai/route";

type Params = Anthropic.Beta.MessageCreateParamsNonStreaming;
const LOCAL: AiConfig = { provider: "ollama", model: "qwen2.5:3b", baseUrl: "http://localhost:11434", cloud: false };
const NOW = new Date("2026-09-26T12:00:00Z");
const KEY = "sk-ant-test-secret-value";

// A NUBAN, the owner's name, people's names, a phone number and an email that must never reach the cloud.
const STATEMENT = Buffer.from([
  "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
  "01-Sep-2026,R1,,1500000.00,1600000.00,W5WM-MONIE MFB-DEEL INC",
  "02-Sep-2026,R2,90000.00,,1510000.00,Instant Payment Outward 0123456789 FROM ADA OKAFOR TO OPAY - NGOZI ADEBAYO",
  "09-Sep-2026,R3,60000.00,,1450000.00,Instant Payment Outward 0123456789 FROM ADA OKAFOR TO KUDA - NGOZI ADEBAYO",
  "10-Sep-2026,R4,45000.00,,1405000.00,POS PURCHASE SHOPRITE LEKKI",
  "12-Sep-2026,R5,30000.00,,1375000.00,Instant Payment Outward 0123456789 MONTHLY TO",
  "14-Sep-2026,R6,25000.00,,1350000.00,Instant Payment Outward FROM ADA OKAFOR TO PALMPAY - CHIDI EZE call 0803 123 4567 chidi.eze@gmail.com",
].join("\n"));

/** Nothing here may appear in anything sent to the cloud. */
const SECRETS = [/0123456789/, /\bNgozi\b/i, /Adebayo/i, /Okafor/i, /\bAda\b/i, /\bChidi\b/i, /\bEze\b/i, /@/, /0803/, /123 4567/, /Main Salary/i];

async function setup(email: string, consent = true) {
  const u = await db.user.create({ data: { email, name: "Ada Okafor", aiConsent: consent } });
  await importStatement(u.id, { name: "s.csv", bytes: STATEMENT }, { institution: "GTBank" });
  await db.account.updateMany({ where: { userId: u.id }, data: { accountName: "Ada Main Salary Account", holderName: "ADA OKAFOR" } });
  return u.id;
}

function msg(content: unknown[], stop = "end_turn"): Anthropic.Beta.BetaMessage {
  return { id: "m", type: "message", role: "assistant", model: "x", content, stop_reason: stop, stop_sequence: null, usage: {} } as unknown as Anthropic.Beta.BetaMessage;
}
const text = (t: string) => ({ type: "text", text: t });
const userText = (p: Params) => JSON.stringify(p.messages);
const rowsIn = (p: Params) => {
  const content = String(p.messages[0].content);
  return JSON.parse(content.slice(content.indexOf("Transactions:\n") + 14)) as Record<string, string>[];
};

/** A fake Claude behind the injectable `create`. Records every request (functions dropped). */
function fakeClaude(reply: (p: Params) => Anthropic.Beta.BetaMessage) {
  const calls: Params[] = [];
  const create = async (p: Params) => {
    calls.push(JSON.parse(JSON.stringify(p)));
    return reply(p);
  };
  return { create, calls };
}

/** The same, installed on the real SDK client, for code paths that build their own cloud call. */
function mockClaudeSdk(reply: (p: Params) => Anthropic.Beta.BetaMessage) {
  const fake = fakeClaude(reply);
  vi.spyOn(anthropic().beta.messages, "create").mockImplementation(fake.create as never);
  return fake;
}

const categorizeReply = (answer: (row: Record<string, string>) => object) => (p: Params) =>
  msg([text(JSON.stringify({ suggestions: rowsIn(p).map((r) => ({ id: r.id, ...answer(r) })) }))]);

/** A fake Ollama for categorization. */
function fakeOllama(answer: (row: Record<string, unknown>) => object | undefined) {
  const calls: Record<string, unknown>[] = [];
  const f: Fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen2.5:3b" }] });
    const body = JSON.parse(String(init!.body)) as { messages: { content: string }[] };
    calls.push(body);
    const user = body.messages[1].content;
    const rows = JSON.parse(user.slice(user.indexOf("Transactions:\n") + 14)) as Record<string, unknown>[];
    const suggestions = rows.flatMap((r) => {
      const a = answer(r);
      return a ? [{ id: r.id, ...a }] : [];
    });
    return Response.json({ message: { role: "assistant", content: JSON.stringify({ suggestions }) } });
  };
  return { fetch: f, calls };
}

const down: Fetch = async () => {
  throw new TypeError("fetch failed");
};

function expectNoSecrets(payload: unknown) {
  const s = JSON.stringify(payload);
  for (const re of SECRETS) expect(s, `cloud payload contains ${re}`).not.toMatch(re);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("routing per mode", () => {
  it("hybrid is the default: local categorization, cloud escalation, insights and chat", () => {
    const r = aiRouting({ ANTHROPIC_API_KEY: KEY });
    expect(r.mode).toBe("hybrid");
    expect(Object.fromEntries(Object.entries(r.features).map(([f, v]) => [f, v.route]))).toEqual({ categorize: "local", escalation: "cloud", insights: "cloud", chat: "cloud" });
    expect(r.notes).toEqual([]);
    expect(aiConfig({ ANTHROPIC_API_KEY: KEY })).toMatchObject({ provider: "ollama", cloud: false });
  });

  it("without a key, hybrid degrades to local-only and says so", () => {
    const r = aiRouting({});
    expect(r.features.categorize.route).toBe("local");
    expect(r.features.insights).toMatchObject({ route: "local", requested: "cloud", note: expect.stringMatching(/ANTHROPIC_API_KEY/) });
    expect(r.features.chat.route).toBe("local");
    expect(r.features.escalation).toMatchObject({ route: "off", requested: "cloud" });
    expect(r.notes.join(" ")).toMatch(/ANTHROPIC_API_KEY is not set.*local-only/);
  });

  it("ollama keeps everything local even with a key and a user asking for cloud", () => {
    const r = aiRouting({ AI_PROVIDER: "ollama", ANTHROPIC_API_KEY: KEY }, { chat: "cloud", escalation: "cloud", insights: "local" });
    expect(r.features.chat).toMatchObject({ route: "local", requested: "cloud", source: "user" });
    expect(r.features.escalation.route).toBe("off");
    expect(r.features.insights.route).toBe("local");
    expect(Object.values(r.features).some((f) => f.route === "cloud")).toBe(false);
  });

  it("anthropic runs in the cloud with a key, and turns cloud features off without one", () => {
    const r = aiRouting({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY });
    expect(r.features.categorize.route).toBe("cloud");
    expect(r.features.escalation).toMatchObject({ route: "off", note: expect.stringMatching(/already/) });
    expect(r.features.chat.route).toBe("cloud");
    const noKey = aiRouting({ AI_PROVIDER: "anthropic" }, { insights: "local" });
    expect(noKey.features.chat.route).toBe("off");
    expect(noKey.features.insights.route).toBe("local");
    expect(aiConfig({ AI_PROVIDER: "anthropic" }).problem).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("off is off, whatever the overrides say", () => {
    const r = aiRouting({ AI_PROVIDER: "off", AI_CHAT: "local", ANTHROPIC_API_KEY: KEY }, { categorize: "local" });
    expect(Object.values(r.features).every((f) => f.route === "off")).toBe(true);
  });

  it("per-feature env overrides, then the user's Settings; nonsense is ignored", () => {
    const env = { ANTHROPIC_API_KEY: KEY, AI_CHAT: "local", AI_ESCALATION: "off", AI_INSIGHTS: "banana" };
    const r = aiRouting(env);
    expect(r.features.chat).toMatchObject({ route: "local", source: "env" });
    expect(r.features.escalation).toMatchObject({ route: "off", source: "env" });
    expect(r.features.insights).toMatchObject({ route: "cloud", source: "mode" });
    const u = aiRouting(env, { chat: "cloud", categorize: "off" });
    expect(u.features.chat).toMatchObject({ route: "cloud", source: "user" });
    expect(u.features.categorize.route).toBe("off");
    expect(u.features.escalation.route).toBe("off");
  });

  it("local features switch off when OLLAMA_BASE_URL is another machine", () => {
    const r = aiRouting({ OLLAMA_BASE_URL: "http://192.168.1.20:11434", ANTHROPIC_API_KEY: KEY });
    expect(r.features.categorize).toMatchObject({ route: "off", note: expect.stringMatching(/this machine/) });
    expect(r.features.escalation.route).toBe("off");
    expect(r.features.chat.route).toBe("cloud");
  });
});

describe("escalation", () => {
  const firstPass = (r: Record<string, unknown>) => {
    if (r.counterparty === "Ngozi Adebayo") return { category: "Family", subcategory: "Black tax", confidence: 0.9, reason: "relative" };
    if (String(r.narration).includes("MONTHLY")) return { category: "Giving", subcategory: "Church", confidence: 0.65, reason: "monthly memo" };
    return { category: "Groceries", subcategory: "", confidence: 0.9, reason: "made up" };
  };

  it("decides which answers need a second opinion", () => {
    const ok = (confidence: number) => ({ ok: true as const, suggestion: { id: "1", category: "Family", subcategory: "Partner", confidence, reason: "" } });
    expect(needsSecondOpinion(ok(0.9))).toBe(false);
    expect(needsSecondOpinion(ok(0.65))).toBe(true);
    expect(needsSecondOpinion({ ok: false, reason: "low confidence" })).toBe(true);
    expect(needsSecondOpinion({ ok: false, reason: "not in the taxonomy" })).toBe(true);
    expect(needsSecondOpinion({ ok: false, reason: "no answer" })).toBe(true);
    expect(needsSecondOpinion({ ok: false, reason: "same as the rules" })).toBe(false);
  });

  it("sends low-confidence and invalid local answers to the cloud, keeps confident ones local, and stores suggestions only", async () => {
    const userId = await setup("hy-esc@test.dev");
    const before = await db.transaction.findMany({ where: { userId }, orderBy: { id: "asc" } });
    const affordBefore = JSON.stringify(await loadAffordabilityData(userId, NOW), (_, x) => (typeof x === "bigint" ? x.toString() : x));
    const { fetch } = fakeOllama(firstPass);
    const claude = fakeClaude(categorizeReply(() => ({ category: "Family", subcategory: "Family support", confidence: 0.86, reason: "regular support" })));
    const second: Categorizer = { llm: cloudCategorizeLLM({ create: claude.create, redactor: await redactorFor(userId) }), provider: "anthropic", model: "claude-opus-5-5" };
    const { ollamaCategorizeLLM } = await import("@/core/ai/categorizer");
    const r = await suggestCategories(userId, { llm: ollamaCategorizeLLM({ config: LOCAL, fetch }), config: LOCAL, escalate: second });

    const rows = await db.transaction.findMany({ where: { userId }, include: { suggestion: true } });
    const ngozi = rows.filter((t) => t.counterparty === "Ngozi Adebayo");
    expect(ngozi.every((t) => t.suggestion?.provider === "ollama" && t.suggestion.subcategory === "Black tax")).toBe(true);
    const escalated = rows.filter((t) => t.suggestion && t.counterparty !== "Ngozi Adebayo");
    expect(escalated.length).toBeGreaterThan(0);
    expect(escalated.every((t) => t.suggestion!.provider === "anthropic" && t.suggestion!.subcategory === "Family support" && t.suggestion!.status === "pending")).toBe(true);
    expect(r).toMatchObject({ escalated: escalated.length, local: { rows: r.asked, suggested: ngozi.length }, cloud: { rows: escalated.length, suggested: escalated.length } });

    // The cloud saw only the escalated rows, redacted
    expect(claude.calls).toHaveLength(1);
    expect(rowsIn(claude.calls[0] as Params)).toHaveLength(escalated.length);
    expectNoSecrets(claude.calls);

    // Nothing auto-applies: labels, amounts and Afford are as the rules left them
    const after = await db.transaction.findMany({ where: { userId }, orderBy: { id: "asc" } });
    const shape = (t: (typeof before)[number]) => [t.category, t.subcategory, t.classificationSource, t.amountMinor];
    expect(after.map(shape)).toEqual(before.map(shape));
    expect(JSON.stringify(await loadAffordabilityData(userId, NOW), (_, x) => (typeof x === "bigint" ? x.toString() : x))).toBe(affordBefore);
  });

  it("when Ollama is down, the cloud answers every row (redacted) instead of the run stopping", async () => {
    const userId = await setup("hy-down@test.dev");
    const claude = fakeClaude(categorizeReply((row) => (String(row.narration).includes("MONTHLY") ? { category: "Giving", subcategory: "Church", confidence: 0.8, reason: "memo" } : { category: "Family", subcategory: "Family support", confidence: 0.8, reason: `support for ${row.counterparty ?? "someone"}` })));
    const flaky: CategorizeLLM = async () => {
      throw new AiUnavailableError("Ollama is not reachable");
    };
    const r = await suggestCategories(userId, { llm: flaky, config: LOCAL, escalate: { llm: cloudCategorizeLLM({ create: claude.create, redactor: await redactorFor(userId) }), provider: "anthropic", model: "claude-opus-5-5" } });
    expect(r.stopped).toBeUndefined();
    expect(r.asked).toBe(r.backlog);
    expect(r).toMatchObject({ local: { rows: 0 }, cloud: { rows: r.backlog } });
    const sent = claude.calls.flatMap((c) => rowsIn(c as Params));
    expect(sent).toHaveLength(r.backlog);
    expectNoSecrets(claude.calls);
    // Amounts are ranges, dates are months, people are placeholders
    expect(sent.every((row) => /^(under|over|₦[\d,]+ to ₦[\d,]+)/.test(row.amount) && /^\d{4}-\d{2}$/.test(row.date))).toBe(true);
    expect(sent.some((row) => /PERSON_\d/.test(JSON.stringify(row)))).toBe(true);
    expect(sent.some((row) => /OWNER/.test(row.narration))).toBe(true);
    // Reasons come back with real names, stored locally
    const reasons = (await db.categorySuggestion.findMany({ where: { userId } })).map((s) => s.reason).join(" ");
    expect(reasons).toMatch(/Ngozi Adebayo/);
    expect(reasons).not.toMatch(/PERSON_/);
  });

  it("when the cloud fails mid-run, local answers are kept and the run carries on", async () => {
    const userId = await setup("hy-clouddown@test.dev");
    const { fetch } = fakeOllama(firstPass);
    const { ollamaCategorizeLLM } = await import("@/core/ai/categorizer");
    const failing: CategorizeLLM = async () => {
      throw new AiUnavailableError("Anthropic returned 529.");
    };
    const r = await suggestCategories(userId, { llm: ollamaCategorizeLLM({ config: LOCAL, fetch }), config: LOCAL, batchSize: 2, escalate: { llm: failing, provider: "anthropic", model: "m" } });
    expect(r.stopped).toBeUndefined();
    expect(r.escalationStopped).toMatch(/529/);
    expect(r.asked).toBe(r.backlog);
    expect(r.cloud.rows).toBe(0);
    const s = await db.categorySuggestion.findMany({ where: { userId } });
    expect(s.every((x) => x.provider === "ollama")).toBe(true);
    expect(s.some((x) => x.status === "pending" && x.subcategory === "Church")).toBe(true); // low but valid local answer kept
  });

  it("stops cleanly, storing nothing, when both models are down", async () => {
    const userId = await setup("hy-alldown@test.dev");
    const no: CategorizeLLM = async () => {
      throw new AiUnavailableError("down");
    };
    const r = await suggestCategories(userId, { llm: no, config: LOCAL, escalate: { llm: no, provider: "anthropic", model: "m" } });
    expect(r.stopped).toMatch(/down/);
    expect(r.asked).toBe(0);
    expect(await db.categorySuggestion.count({ where: { userId } })).toBe(0);
  });

  it("default routing with a key: Ollama first, the real SDK client for escalation, all mocked", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    const userId = await setup("hy-default@test.dev");
    const { fetch, calls: local } = fakeOllama(firstPass);
    const claude = mockClaudeSdk(categorizeReply(() => ({ category: "Family", subcategory: "Family support", confidence: 0.86, reason: "x" })));
    const r = await suggestCategories(userId, { fetch });
    expect(local.length).toBeGreaterThan(0);
    expect(claude.calls.length).toBeGreaterThan(0);
    expect(r.escalated).toBeGreaterThan(0);
    expectNoSecrets(claude.calls);
    expect(claude.calls[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default" });
  });

  it("without a key nothing goes to the cloud, even for unsure rows", async () => {
    const userId = await setup("hy-nokey@test.dev");
    const { fetch } = fakeOllama(firstPass);
    const spy = vi.spyOn(anthropic().beta.messages, "create");
    const r = await suggestCategories(userId, { fetch });
    expect(r.asked).toBeGreaterThan(0);
    expect(r.cloud.rows).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("chat and insights routing", () => {
  it("chat on the cloud: everything redacted on the way out, names restored on the way back", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    const userId = await setup("hy-chat@test.dev");
    let placeholder = "";
    const claude = fakeClaude((p) => {
      const last = p.messages.at(-1)!;
      if (typeof last.content === "string") {
        placeholder = last.content.match(/PERSON_\d+/)![0];
        return msg([{ type: "tool_use", id: "t1", name: "person_summary", input: { name: placeholder } }], "tool_use");
      }
      const result = JSON.parse(String((last.content as { content: string }[])[0].content));
      return msg([text(`You sent ${placeholder} ${result.total_sent} in total.`)]);
    });
    const reply = await chatForUser(userId, "How much have I sent Ngozi Adebayo? My number is 08031234567.", [{ role: "user", text: "Hi, I am Ada Okafor" }, { role: "assistant", text: "Hello Ada Okafor" }], { create: claude.create, now: NOW });
    expect(reply).toMatchObject({ provider: "anthropic", grounded: true, text: "You sent Ngozi Adebayo ₦150,000 in total." });
    // The tool ran locally with the real name; the exact figures stay local
    expect(reply!.toolCalls[0]).toMatchObject({ tool: "person_summary", input: { name: "Ngozi Adebayo" }, output: { total_sent: "₦150,000.00" } });
    expectNoSecrets(claude.calls);
    expect(JSON.stringify(claude.calls)).not.toMatch(/150,000\.00|1,500,000\.00/);
  });

  it("chat falls back to the local model when the cloud fails, and to rules when both do", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    const userId = await setup("hy-chat-fallback@test.dev");
    const broken = async (): Promise<Anthropic.Beta.BetaMessage> => {
      throw new AiUnavailableError("Could not reach Anthropic.");
    };
    const ollama: Fetch = async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { messages: { role: string; content: string }[]; tools?: unknown[] };
      expect(body.tools?.length).toBeGreaterThan(0);
      const last = body.messages.at(-1)!;
      if (last.role === "user") return Response.json({ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "get_period_summary", arguments: { period: "September 2026" } } }] } });
      const out = JSON.parse(last.content) as { income: string };
      return Response.json({ message: { role: "assistant", content: `You received ${out.income} in September 2026.` } });
    };
    const local = await chatForUser(userId, "How did September go?", [], { create: broken, fetch: ollama, now: NOW });
    expect(local).toMatchObject({ provider: "ollama", grounded: true, text: "You received ₦1,500,000.00 in September 2026." });
    expect(await chatForUser(userId, "How did September go?", [], { create: broken, fetch: down, now: NOW })).toBeUndefined();
  });

  it("chat without a key runs locally and never calls the cloud; chat off means rules", async () => {
    const userId = await setup("hy-chat-local@test.dev");
    const spy = vi.spyOn(anthropic().beta.messages, "create");
    const ollama: Fetch = async () => Response.json({ message: { role: "assistant", content: "Ask me about a month." } });
    expect(await chatForUser(userId, "hello", [], { fetch: ollama, now: NOW })).toMatchObject({ provider: "ollama" });
    expect(spy).not.toHaveBeenCalled();
    await setUserPrefs(userId, { chat: "off" });
    expect(await chatForUser(userId, "hello", [], { fetch: ollama, now: NOW })).toBeUndefined();
  });

  it("insights phrasing on the cloud gets rounded, redacted facts and no raw kobo", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    const userId = await setup("hy-insights@test.dev");
    const { facts } = await ask(userId, "Find all transfers to Ngozi Adebayo", NOW);
    expect(facts.rows?.length).toBe(2);
    const claude = fakeClaude((p) => {
      const ph = userText(p).match(/PERSON_\d+/)![0];
      return msg([text(`You sent ${ph} about ₦150,000 across both transfers.`)]);
    });
    const out = await phraseForUser(userId, "Find all transfers to Ngozi Adebayo", facts, { create: claude.create });
    expect(out).toEqual({ text: "You sent Ngozi Adebayo about ₦150,000 across both transfers.", source: "llm", provider: "anthropic" });
    expectNoSecrets(claude.calls);
    expect(userText(claude.calls[0])).not.toMatch(/15000000|90,000\.00|headline/);
  });

  it("insights phrasing without a key runs on Ollama with the exact facts, and an invented figure falls back to the template", async () => {
    const userId = await setup("hy-insights-local@test.dev");
    const { facts } = await ask(userId, "How much did I spend in September 2026?", NOW);
    const seen: string[] = [];
    const ollama = (answer: (factsJson: { facts: { value: string }[] }) => string): Fetch => async (_u, init) => {
      const body = JSON.parse(String(init!.body)) as { messages: { content: string }[]; format: object };
      expect(body.format).toMatchObject({ required: ["answer"] });
      const user = body.messages[1].content;
      seen.push(user);
      const f = JSON.parse(user.slice(user.indexOf("FACTS:\n") + 7));
      return Response.json({ message: { content: JSON.stringify({ answer: answer(f) }) } });
    };
    const good = await phraseForUser(userId, "How much did I spend?", facts, { fetch: ollama((f) => `You spent ${f.facts[0].value} in September.`) });
    expect(good).toMatchObject({ source: "llm", provider: "ollama" });
    expect(seen[0]).toContain(facts.facts[0].value);
    const bad = await phraseForUser(userId, "How much did I spend?", facts, { fetch: ollama(() => "You spent ₦9,999,999.00.") });
    expect(bad).toEqual({ text: facts.headline, source: "template" });
  });

  it("logs which provider served a request, never the content", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("NODE_ENV", "production");
    const userId = await setup("hy-log@test.dev");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
    const { facts } = await ask(userId, "Find all transfers to Ngozi Adebayo", NOW);
    const claude = fakeClaude(() => msg([text("You sent them money.")]));
    await phraseForUser(userId, "Find all transfers to Ngozi Adebayo", facts, { create: claude.create });
    const served = lines.map((l) => JSON.parse(l)).filter((l) => l.event === "ai.served");
    expect(served).toEqual([expect.objectContaining({ feature: "insights", provider: "anthropic", model: "claude-opus-5-5", outcome: "ok" })]);
    expect(lines.join("\n")).not.toMatch(/Ngozi|PERSON_|sent them/);
  });
});

describe("Settings API", () => {
  const req = (token: string, body?: unknown) =>
    new Request("http://localhost/api/v1/ai", {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("shows both providers, where each feature runs and whether the key is set, never the key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.spyOn(anthropic().models, "list").mockResolvedValue({} as never);
    const userId = await setup("hy-api@test.dev");
    const { token } = await issueSession(userId);
    const res = await aiGet(req(token));
    const raw = await res.text();
    expect(raw).not.toContain(KEY);
    const body = JSON.parse(raw);
    expect(body).toMatchObject({
      mode: "hybrid", provider: "ollama", cloud: true,
      cloudProvider: { provider: "anthropic", keySet: true, reachable: true },
      local: { provider: "ollama", model: "qwen2.5:3b" },
      routes: { categorize: { route: "local" }, escalation: { route: "cloud" }, insights: { route: "cloud" }, chat: { route: "cloud", source: "mode", serverDefault: "cloud" } },
    });
    expect(typeof body.local.reachable).toBe("boolean");

    const set = await (await aiPost(req(token, { routes: { chat: "local", escalation: "off" } }))).json();
    expect(set.routes.chat).toMatchObject({ route: "local", requested: "local", source: "user" });
    expect(set.routes.escalation.route).toBe("off");
    const back = await (await aiPost(req(token, { routes: { chat: "default" } }))).json();
    expect(back.routes.chat).toMatchObject({ route: "cloud", source: "mode" });
    expect((await aiPost(req(token, { routes: { chat: "mars" } }))).status).toBe(400);
    expect((await aiPost(req(token, { routes: { telepathy: "local" } }))).status).toBe(400);
    expect((await aiPost(req(token, {}))).status).toBe(400);
  });

  it("without a key: nothing cloud, a clear note, and everything still works locally", async () => {
    const userId = await setup("hy-api-nokey@test.dev");
    const { token } = await issueSession(userId);
    const body = await (await aiGet(req(token))).json();
    expect(body).toMatchObject({ cloud: false, cloudProvider: { keySet: false, reachable: false }, routes: { insights: { route: "local" }, chat: { route: "local" }, escalation: { route: "off" } } });
    expect(body.notes.join(" ")).toMatch(/ANTHROPIC_API_KEY is not set/);
    // A user asking for cloud still gets local, with the reason
    const set = await (await aiPost(req(token, { routes: { chat: "cloud" } }))).json();
    expect(set.routes.chat).toMatchObject({ route: "local", requested: "cloud", note: expect.stringMatching(/ANTHROPIC_API_KEY/) });
  });
});

describe("npm run ai:suggest --escalate", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };

  it("parses --escalate and --no-escalate", () => {
    expect(parseSuggestArgs([]).escalate).toBeUndefined();
    expect(parseSuggestArgs(["--escalate"]).escalate).toBe(true);
    expect(parseSuggestArgs(["--no-escalate"]).escalate).toBe(false);
  });

  it("escalates by default in hybrid and reports local vs cloud", async () => {
    const userId = await setup("hy-cli@test.dev");
    const { fetch } = fakeOllama((r) => (r.counterparty === "Ngozi Adebayo" ? { category: "Family", subcategory: "Black tax", confidence: 0.9, reason: "x" } : { category: "Giving", subcategory: "Church", confidence: 0.62, reason: "unsure" }));
    const claude = fakeClaude(categorizeReply(() => ({ category: "Family", subcategory: "Family support", confidence: 0.9, reason: "y" })));
    const t = io();
    const code = await runSuggestCli(parseSuggestArgs(["--email", "hy-cli@test.dev"]), {
      ...t.io, routing: aiRouting({ ANTHROPIC_API_KEY: KEY }), fetch,
      escalate: { llm: cloudCategorizeLLM({ create: claude.create, redactor: await redactorFor(userId) }), provider: "anthropic", model: "claude-opus-5-5" },
    });
    expect(code).toBe(0);
    const s = t.out.join("\n");
    expect(s).toMatch(/Escalation: Anthropic \(cloud, redacted\)/);
    const n = await db.categorySuggestion.count({ where: { userId, provider: "anthropic" } });
    expect(n).toBeGreaterThan(0);
    expect(s).toMatch(new RegExp(`Cloud: ${n} rows sent \\(${n} escalated\\), ${n} suggestions`));
    expect(s).toMatch(/Local: \d+ rows sent, 2 suggestions/);
    expectNoSecrets(claude.calls);
  });

  it("--no-escalate stays local; with Ollama down it exits as before", async () => {
    await setup("hy-cli-local@test.dev");
    const t = io();
    const code = await runSuggestCli(parseSuggestArgs(["--email", "hy-cli-local@test.dev", "--no-escalate"]), { ...t.io, routing: aiRouting({ ANTHROPIC_API_KEY: KEY }), fetch: down });
    expect(code).toBe(2);
    expect(t.out.join("\n")).toMatch(/Escalation: off \(--no-escalate\)/);
    expect(t.err.join("\n")).toMatch(/ollama serve/);
  });

  it("with Ollama down, hybrid sends the backlog to the cloud instead of giving up", async () => {
    const userId = await setup("hy-cli-down@test.dev");
    const claude = fakeClaude(categorizeReply(() => ({ category: "Family", subcategory: "Family support", confidence: 0.9, reason: "y" })));
    const t = io();
    const code = await runSuggestCli(parseSuggestArgs(["--email", "hy-cli-down@test.dev"]), {
      ...t.io, routing: aiRouting({ ANTHROPIC_API_KEY: KEY }), fetch: down,
      escalate: { llm: cloudCategorizeLLM({ create: claude.create, redactor: await redactorFor(userId) }), provider: "anthropic", model: "claude-opus-5-5" },
    });
    expect(code).toBe(0);
    expect(t.out.join("\n")).toMatch(/cloud model instead/);
    expect(t.out.join("\n")).toMatch(/Local: 0 rows sent, 0 suggestions/);
    expect(await db.categorySuggestion.count({ where: { userId, provider: "anthropic" } })).toBeGreaterThan(0);
    expectNoSecrets(claude.calls);
  });
});
