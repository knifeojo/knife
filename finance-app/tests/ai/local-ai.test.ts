import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { issueSession } from "@/lib/auth";
import { importStatement } from "@/core/statement-import";
import { ALL_CATEGORIES } from "@/core/categorize";
import { INCOME_OPTIONS, PERSON_OPTIONS } from "@/core/review";
import { TAXONOMY, canonicalLabel } from "@/core/taxonomy";
import { DEFAULT_OLLAMA_MODEL, aiConfig, isLocalUrl, type AiConfig } from "@/core/ai/client";
import { AiUnavailableError, aiStatus, ollamaChat, type Fetch } from "@/core/ai/ollama";
import { AI_ROW_FIELDS, ollamaCategorizeLLM, suggestCategories, toAiRow, validateSuggestion, type CategorizeLLM } from "@/core/ai/categorizer";
import { confirmSuggestion, dismissSuggestion, reviewWithSuggestions } from "@/core/ai/suggestions";
import { parseSuggestArgs, runSuggestCli } from "@/core/ai/batch";
import { loadAffordabilityData } from "@/core/affordability";
import { GET as aiGet, POST as aiPost } from "@/app/api/v1/ai/route";
import { GET as reviewGet } from "@/app/api/v1/review/route";
import { POST as suggestionPost } from "@/app/api/v1/review/suggestions/route";

const LOCAL: AiConfig = { provider: "ollama", model: "qwen2.5:3b", baseUrl: "http://localhost:11434", cloud: false };

// A 10-digit NUBAN and an owner account name that must never reach the model.
const STATEMENT = Buffer.from([
  "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
  "01-Sep-2026,R1,,1500000.00,1600000.00,W5WM-MONIE MFB-DEEL INC",
  "02-Sep-2026,R2,90000.00,,1510000.00,Instant Payment Outward 0123456789 FROM ADA OKAFOR TO OPAY - NGOZI ADEBAYO",
  "09-Sep-2026,R3,60000.00,,1450000.00,Instant Payment Outward 0123456789 FROM ADA OKAFOR TO KUDA - NGOZI ADEBAYO",
  "10-Sep-2026,R4,45000.00,,1405000.00,POS PURCHASE SHOPRITE LEKKI",
  "12-Sep-2026,R5,30000.00,,1375000.00,Instant Payment Outward 0123456789 MONTHLY TO",
].join("\n"));

async function setup(email: string, consent = true) {
  const u = await db.user.create({ data: { email, aiConsent: consent } });
  await importStatement(u.id, { name: "s.csv", bytes: STATEMENT }, { institution: "GTBank" });
  return u.id;
}

/** A fake Ollama: answers /api/tags and /api/chat, recording every request. Never touches the network. */
function fakeOllama(answer: (rows: Record<string, unknown>[]) => unknown[], opts: { models?: string[] } = {}) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const f: Fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    if (url.endsWith("/api/tags")) return Response.json({ models: (opts.models ?? ["qwen2.5:3b"]).map((name) => ({ name })) });
    const user = String((body!.messages as { role: string; content: string }[])[1].content);
    const rows = JSON.parse(user.slice(user.indexOf("Transactions:\n") + 14)) as Record<string, unknown>[];
    return Response.json({ message: { role: "assistant", content: JSON.stringify({ suggestions: answer(rows) }) } });
  };
  return { fetch: f, calls };
}

const refused: Fetch = async () => {
  throw new TypeError("fetch failed");
};

describe("AI provider config", () => {
  it("defaults to local Ollama with a small model, and swaps model and URL from env", () => {
    expect(aiConfig({})).toEqual({ provider: "ollama", model: DEFAULT_OLLAMA_MODEL, baseUrl: "http://localhost:11434", cloud: false });
    expect(DEFAULT_OLLAMA_MODEL).toBe("qwen2.5:3b");
    expect(aiConfig({ AI_PROVIDER: "ollama", OLLAMA_MODEL: "llama3.1:8b", OLLAMA_BASE_URL: "http://127.0.0.1:11500/" })).toMatchObject({ model: "llama3.1:8b", baseUrl: "http://127.0.0.1:11500" });
  });

  it("never picks the cloud because a key exists; only an explicit AI_PROVIDER does", () => {
    expect(aiConfig({ ANTHROPIC_API_KEY: "sk-test" }).provider).toBe("ollama");
    expect(aiConfig({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test" })).toMatchObject({ provider: "anthropic", cloud: true, problem: undefined });
    expect(aiConfig({ AI_PROVIDER: "anthropic" }).problem).toMatch(/ANTHROPIC_API_KEY/);
    expect(aiConfig({ AI_PROVIDER: "off" }).provider).toBe("off");
  });

  it("refuses an Ollama URL that is not this machine", async () => {
    expect(isLocalUrl("http://localhost:11434")).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isLocalUrl("http://[::1]:11434")).toBe(true);
    expect(isLocalUrl("http://100.64.0.8:11434")).toBe(false);
    expect(isLocalUrl("https://ollama.example.com")).toBe(false);
    expect(isLocalUrl("http://localhost.evil.com")).toBe(false);
    const remote = aiConfig({ OLLAMA_BASE_URL: "http://192.168.1.20:11434" });
    expect(remote.problem).toMatch(/this machine/);
    const { fetch, calls } = fakeOllama(() => []);
    await expect(ollamaChat({ system: "", user: "", schema: {} }, { config: remote, fetch })).rejects.toBeInstanceOf(AiUnavailableError);
    expect((await aiStatus({ config: remote, fetch })).reachable).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("taxonomy", () => {
  it("covers every category and every Review answer", () => {
    expect(Object.keys(TAXONOMY).sort()).toEqual([...ALL_CATEGORIES].sort());
    for (const o of [...PERSON_OPTIONS, ...INCOME_OPTIONS]) expect(canonicalLabel(o.category, o.subcategory)).toBeDefined();
    expect(canonicalLabel("family", "black TAX")).toEqual({ category: "Family", subcategory: "Black tax" });
    expect(canonicalLabel("Debt", "Loan repayment")).toEqual({ category: "Debt", subcategory: "Loan repayment" });
    expect(canonicalLabel("Own transfer", "")).toEqual({ category: "Own transfer", subcategory: null });
    expect(canonicalLabel("Giving", "Church")).toBeDefined();
  });

  it("rejects labels outside the taxonomy, wrong direction, generic or unsure answers", () => {
    const debit = { type: "DEBIT", category: "Transfers", subcategory: null };
    const ok = (category: string, subcategory: string, confidence = 0.8) => validateSuggestion({ id: "1", category, subcategory, confidence, reason: "r" }, debit);
    expect(ok("Family", "Black tax")).toMatchObject({ ok: true, suggestion: { category: "Family", subcategory: "Black tax" } });
    expect(ok("Groceries", "")).toMatchObject({ ok: false, reason: "not in the taxonomy" });
    expect(ok("Family", "Cousins")).toMatchObject({ ok: false, reason: "not in the taxonomy" });
    expect(ok("Income", "Salary")).toMatchObject({ ok: false });
    expect(ok("Transfers", "")).toMatchObject({ ok: false, reason: "too generic" });
    expect(ok("Family", "Partner", 0.3)).toMatchObject({ ok: false, reason: "low confidence" });
    expect(ok("Family", "Partner", 7)).toMatchObject({ ok: false, reason: "bad confidence" });
    expect(validateSuggestion({ id: "1", category: "Food", subcategory: "", confidence: 0.9 }, { type: "CREDIT", category: "Income", subcategory: "Transfer" })).toMatchObject({ ok: false });
    expect(validateSuggestion("Family", debit)).toMatchObject({ ok: false });
  });
});

describe("Ollama provider (mocked)", () => {
  it("posts to /api/chat with a JSON schema constrained to the categories", async () => {
    const { fetch, calls } = fakeOllama((rows) => rows.map((r) => ({ id: r.id, category: "Family", subcategory: "Black tax", confidence: 0.8, reason: "x" })));
    const out = await ollamaCategorizeLLM({ config: LOCAL, fetch })([{ id: "1", date: "2026-09-02", direction: "out", amount: "₦1.00", narration: "TO X" }]);
    expect(out).toEqual([{ id: "1", category: "Family", subcategory: "Black tax", confidence: 0.8, reason: "x" }]);
    expect(calls[0].url).toBe("http://localhost:11434/api/chat");
    expect(calls[0].body).toMatchObject({ model: "qwen2.5:3b", stream: false });
    const format = calls[0].body!.format as { properties: { suggestions: { items: { properties: { category: { enum: string[] } } } } } };
    expect(format.properties.suggestions.items.properties.category.enum).toEqual(ALL_CATEGORIES);
    expect(String((calls[0].body!.messages as { content: string }[])[1].content)).toContain("Family: Family support, Partner, Parents, Black tax");
  });

  it("explains an unreachable server and a missing model instead of crashing", async () => {
    await expect(ollamaChat({ system: "", user: "", schema: {} }, { config: LOCAL, fetch: refused })).rejects.toThrow(/ollama serve/);
    const missing: Fetch = async () => Response.json({ error: "model not found" }, { status: 404 });
    await expect(ollamaChat({ system: "", user: "", schema: {} }, { config: LOCAL, fetch: missing })).rejects.toThrow(/ollama pull qwen2.5:3b/);
    expect(await aiStatus({ config: LOCAL, fetch: refused })).toMatchObject({ reachable: false, modelInstalled: false });
    expect(await aiStatus({ config: LOCAL, fetch: fakeOllama(() => [], { models: ["llama3.2:1b"] }).fetch })).toMatchObject({ reachable: true, modelInstalled: false });
    expect(await aiStatus({ config: LOCAL, fetch: fakeOllama(() => []).fetch })).toMatchObject({ reachable: true, modelInstalled: true });
    // Garbage instead of JSON is "no answer", not an exception
    const garbage: Fetch = async () => Response.json({ message: { content: "Sure! Here are the categories" } });
    expect(await ollamaCategorizeLLM({ config: LOCAL, fetch: garbage })([])).toEqual([]);
  });

  it("stops a run when Ollama goes away, keeps what it had, and resumes later", async () => {
    const userId = await setup("ai-resume@test.dev");
    let calls = 0;
    const flaky: CategorizeLLM = async (rows) => {
      if (++calls > 1) throw new AiUnavailableError("Ollama is not reachable");
      return rows.map((r) => ({ id: r.id, category: "Family", subcategory: "Black tax", confidence: 0.8, reason: "x" }));
    };
    const first = await suggestCategories(userId, { llm: flaky, config: LOCAL, batchSize: 1 });
    expect(first.stopped).toMatch(/not reachable/);
    expect(first.asked).toBe(1);
    expect(await db.categorySuggestion.count({ where: { userId } })).toBe(1);
    const asked: string[] = [];
    const steady: CategorizeLLM = async (rows) => {
      asked.push(...rows.map((r) => r.narration));
      return rows.map((r) => ({ id: r.id, category: "Family", subcategory: "Black tax", confidence: 0.8, reason: "x" }));
    };
    const second = await suggestCategories(userId, { llm: steady, config: LOCAL, batchSize: 1 });
    expect(second.stopped).toBeUndefined();
    expect(second.asked).toBe(first.backlog - 1);
    const third = await suggestCategories(userId, { llm: steady, config: LOCAL });
    expect(third).toMatchObject({ backlog: 0, asked: 0 });
  });
});

describe("privacy", () => {
  it("sends only narration, payee, merchant, amount, direction and date, with no account numbers or balances", async () => {
    const userId = await setup("ai-privacy@test.dev");
    await db.account.updateMany({ where: { userId }, data: { accountName: "Ada Main Salary Account", holderName: "ADA OKAFOR" } });
    const { fetch, calls } = fakeOllama((rows) => rows.map((r) => ({ id: r.id, category: "Family", subcategory: "Black tax", confidence: 0.8, reason: "x" })));
    await suggestCategories(userId, { llm: ollamaCategorizeLLM({ config: LOCAL, fetch }), config: LOCAL });
    const chat = calls.filter((c) => c.url.endsWith("/api/chat"));
    expect(chat.length).toBeGreaterThan(0);
    for (const c of chat) {
      expect(new URL(c.url).hostname).toBe("localhost");
      const user = String((c.body!.messages as { content: string }[])[1].content);
      const rows = JSON.parse(user.slice(user.indexOf("Transactions:\n") + 14)) as Record<string, unknown>[];
      for (const row of rows) expect(Object.keys(row).every((k) => (AI_ROW_FIELDS as readonly string[]).includes(k))).toBe(true);
      const everything = JSON.stringify(c.body);
      expect(everything).not.toMatch(/0123456789|\d{6,}/); // account numbers
      expect(everything).not.toMatch(/1,?510,?000|1,?450,?000|balance/i); // balances
      expect(everything).not.toMatch(/Main Salary Account|GTBank|cuid|accountId|userId/);
    }
    const t = await db.transaction.findFirstOrThrow({ where: { userId, reference: "R2" } });
    expect(Object.keys(toAiRow("1", t)).sort()).toEqual(["amount", "counterparty", "date", "direction", "id", "narration"]);
  });
});

describe("suggestions in Review", () => {
  const blackTax: CategorizeLLM = async (rows) =>
    rows.map((r) =>
      r.counterparty === "Ngozi Adebayo"
        ? { id: r.id, category: "Family", subcategory: "Black tax", confidence: 0.84, reason: "Regular support to a relative" }
        : { id: r.id, category: "Giving", subcategory: "Church", confidence: 0.7, reason: "monthly memo" },
    );

  it("pre-selects the AI pick on the matching question, and confirming saves a rule that labels every payment", async () => {
    const userId = await setup("ai-review@test.dev");
    await suggestCategories(userId, { llm: blackTax, config: LOCAL });
    const { questions, suggestions } = await reviewWithSuggestions(userId);
    const q = questions.find((x) => x.key === "ngozi adebayo");
    expect(q?.aiSuggestion).toMatchObject({ category: "Family", subcategory: "Black tax", count: 2, totalMinor: 15_000_000n });
    expect(suggestions.find((s) => s.display === "Ngozi Adebayo")).toBeUndefined();

    const updated = await confirmSuggestion(userId, q!.aiSuggestion!.id);
    expect(updated).toBe(2);
    const rows = await db.transaction.findMany({ where: { userId, counterparty: "Ngozi Adebayo" }, include: { suggestion: true } });
    expect(rows.every((r) => r.category === "Family" && r.subcategory === "Black tax" && r.classificationSource === "user")).toBe(true);
    expect(rows.every((r) => r.suggestion?.status === "confirmed")).toBe(true);
    const rule = await db.merchantAlias.findFirstOrThrow({ where: { userId, pattern: "ngozi adebayo" } });
    expect(rule).toMatchObject({ category: "Family", subcategory: "Black tax" });

    // The next statement labels the same payee by rule, so the AI is never asked about them again
    await importStatement(userId, { name: "oct.csv", bytes: Buffer.from("Trans. Date,Reference,Debits,Credits,Balance,Remarks\n02-Oct-2026,R9,70000.00,,1000000.00,Instant Payment Outward 0555 TO OPAY - NGOZI ADEBAYO") }, { institution: "GTBank" });
    expect(await db.transaction.findFirstOrThrow({ where: { userId, reference: "R9" } })).toMatchObject({ category: "Family", subcategory: "Black tax", classificationSource: "user" });
    const sent: string[] = [];
    await suggestCategories(userId, { llm: async (r) => (sent.push(...r.map((x) => x.narration)), []), config: LOCAL });
    expect(sent.join(" ")).not.toMatch(/NGOZI/);
  });

  it("keeps Afford rule-based: suggestions change nothing until confirmed", async () => {
    const userId = await setup("ai-afford@test.dev");
    const now = new Date("2026-09-20T09:00:00Z");
    const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
    const before = json(await loadAffordabilityData(userId, now));
    await suggestCategories(userId, { llm: blackTax, config: LOCAL });
    expect(await db.categorySuggestion.count({ where: { userId, status: "pending" } })).toBeGreaterThan(0);
    expect(json(await loadAffordabilityData(userId, now))).toBe(before);
    const { suggestions } = await reviewWithSuggestions(userId);
    await dismissSuggestion(userId, suggestions[0]?.id ?? (await db.categorySuggestion.findFirstOrThrow({ where: { userId, status: "pending" } })).id);
    expect(json(await loadAffordabilityData(userId, now))).toBe(before);
  });

  it("dry run asks the model but stores nothing", async () => {
    const userId = await setup("ai-dry@test.dev");
    const r = await suggestCategories(userId, { llm: blackTax, config: LOCAL, dryRun: true });
    expect(r.preview.length).toBe(r.asked);
    expect(r.preview.some((p) => p.suggestion?.subcategory === "Black tax")).toBe(true);
    expect(await db.categorySuggestion.count({ where: { userId } })).toBe(0);
  });
});

describe("npm run ai:suggest", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };

  it("parses --limit, --dry-run and friends", () => {
    expect(parseSuggestArgs(["--limit", "50", "--dry-run"])).toMatchObject({ limit: 50, dryRun: true, retryFailed: false });
    expect(parseSuggestArgs([])).toMatchObject({ limit: 50, dryRun: false });
    expect(parseSuggestArgs(["--limit", "abc", "--email", "a@b.c", "--batch", "4"])).toMatchObject({ limit: 50, email: "a@b.c", batch: 4 });
  });

  it("says Ollama is not running and exits cleanly without touching the database", async () => {
    await setup("ai-cli-down@test.dev");
    const t = io();
    const code = await runSuggestCli(parseSuggestArgs(["--email", "ai-cli-down@test.dev"]), { ...t.io, config: LOCAL, fetch: refused });
    expect(code).toBe(2);
    expect(t.err.join("\n")).toMatch(/ollama serve/);
    expect(t.err.join("\n")).toMatch(/keeps working without AI/);
    expect(await db.categorySuggestion.count({ where: { user: { email: "ai-cli-down@test.dev" } } })).toBe(0);
  });

  it("processes the backlog in batches with progress, and is safe to re-run", async () => {
    const userId = await setup("ai-cli@test.dev", false);
    const { fetch } = fakeOllama((rows) => rows.map((r) => ({ id: r.id, category: "Family", subcategory: "Black tax", confidence: 0.8, reason: "x" })));
    const off = io();
    expect(await runSuggestCli(parseSuggestArgs(["--email", "ai-cli@test.dev"]), { ...off.io, config: LOCAL, fetch })).toBe(1);
    expect(off.err.join(" ")).toMatch(/switched off/);

    const t = io();
    expect(await runSuggestCli(parseSuggestArgs(["--email", "ai-cli@test.dev", "--limit", "2", "--batch", "1", "--enable"]), { ...t.io, config: LOCAL, fetch })).toBe(0);
    expect(t.out.filter((l) => /^\[\d\/2\]/.test(l))).toHaveLength(2);
    expect(t.out.join("\n")).toMatch(/Run again to continue/);
    expect(await db.categorySuggestion.count({ where: { userId } })).toBe(2);

    const again = io();
    expect(await runSuggestCli(parseSuggestArgs(["--email", "ai-cli@test.dev", "--limit", "50"]), { ...again.io, config: LOCAL, fetch })).toBe(0);
    const total = await db.categorySuggestion.count({ where: { userId } });
    const last = io();
    await runSuggestCli(parseSuggestArgs(["--email", "ai-cli@test.dev"]), { ...last.io, config: LOCAL, fetch });
    expect(last.out.join("\n")).toMatch(/Nothing to do/);
    expect(await db.categorySuggestion.count({ where: { userId } })).toBe(total);
  });
});

describe("mobile API", () => {
  const req = (path: string, token: string, body?: unknown) =>
    new Request(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("reports AI status and toggles it", async () => {
    const userId = await setup("ai-api@test.dev", false);
    const { token } = await issueSession(userId);
    const status = await (await aiGet(req("/api/v1/ai", token))).json();
    expect(status).toMatchObject({ provider: "ollama", model: "qwen2.5:3b", cloud: false, enabled: false, available: true });
    expect(typeof status.reachable).toBe("boolean");
    const on = await aiPost(req("/api/v1/ai", token, { enabled: true }));
    expect(on.status).toBe(200);
    expect((await on.json()).enabled).toBe(true);
    expect((await aiPost(req("/api/v1/ai", token, { enabled: "yes" }))).status).toBe(400);
  });

  it("returns AI picks with Review and confirms one with a tap", async () => {
    const userId = await setup("ai-api-review@test.dev");
    const { token } = await issueSession(userId);
    await suggestCategories(userId, {
      llm: async (rows) => rows.map((r) => ({ id: r.id, category: "Family", subcategory: "Black tax", confidence: 0.8, reason: "relative" })),
      config: LOCAL,
    });
    const body = await (await reviewGet(req("/api/v1/review", token))).json();
    const q = body.questions.find((x: { key: string }) => x.key === "ngozi adebayo");
    expect(q.aiSuggestion).toMatchObject({ category: "Family", subcategory: "Black tax", classificationSource: "ai", totalMinor: "15000000" });
    expect(Array.isArray(body.suggestions)).toBe(true);
    const res = await suggestionPost(req("/api/v1/review/suggestions", token, { id: q.aiSuggestion.id, action: "confirm" }));
    expect(await res.json()).toEqual({ updated: 2 });
    expect((await suggestionPost(req("/api/v1/review/suggestions", token, { id: q.aiSuggestion.id, action: "confirm" }))).status).toBe(404);
    expect((await suggestionPost(req("/api/v1/review/suggestions", token, { id: "x", action: "apply" }))).status).toBe(400);
  });
});
