import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { issueSession } from "@/lib/auth";
import { ingestTransaction } from "@/core/ledger";
import { parseAffordAsk } from "@/core/ask/mobile";
import { GET, POST } from "@/app/api/v1/ask/route";

const saved = {
  provider: process.env.AI_PROVIDER,
  key: process.env.ANTHROPIC_API_KEY,
};

beforeAll(() => {
  process.env.AI_PROVIDER = "off";
  delete process.env.ANTHROPIC_API_KEY;
});

afterAll(() => {
  if (saved.provider === undefined) delete process.env.AI_PROVIDER;
  else process.env.AI_PROVIDER = saved.provider;
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.key;
});

function post(body: unknown, token?: string) {
  return POST(new Request("http://localhost/api/v1/ask", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));
}

describe("Ask", () => {
  it("parses naira amounts with k, m and the naira sign", () => {
    expect(parseAffordAsk("Can I afford N50k?")).toMatchObject({ amountMinor: 5_000_000n });
    expect(parseAffordAsk("can I afford ₦50,000")).toMatchObject({ amountMinor: 5_000_000n });
    expect(parseAffordAsk("Can I afford 2.5m for a car")).toMatchObject({ amountMinor: 250_000_000n });
    expect(parseAffordAsk("Can I afford...?")).toEqual({ needAmount: true });
    expect(parseAffordAsk("Where did my money go this month?")).toBeNull();
  });

  it("answers from the ledger, keeps history, and does not call a model when the key is missing", async () => {
    const user = await db.user.create({ data: { email: "ask-mobile@test.dev" } });
    const token = (await issueSession(user.id)).token;
    await ingestTransaction(user.id, {
      institution: "GTBank",
      source: "statement",
      sourceTransactionId: "shop-1",
      type: "DEBIT",
      amountMinor: 1_845_000n,
      currency: "NGN",
      transactionDate: new Date(Date.now() - 5 * 86_400_000),
      description: "POS SHOPRITE LEKKI",
      accountLast4: "1234",
      confidence: 1,
    });
    await db.account.updateMany({ where: { userId: user.id }, data: { balanceMinor: 200_000_000n, balanceUpdatedAt: new Date() } });
    const loan = await db.loan.create({
      data: { userId: user.id, lender: "FairMoney", status: "closed", outstandingMinor: 0n, instalmentMinor: 5_000_000n },
    });
    await db.loanClearedEvent.create({
      data: {
        userId: user.id,
        loanId: loan.id,
        lender: "FairMoney",
        totalRepaidMinor: 20_000_000n,
        freedPerMonthMinor: 5_000_000n,
        closedAt: new Date("2026-10-01T00:00:00.000Z"),
      },
    });

    const afford = await post({ question: "Can I afford N50k?" }, token);
    expect(afford.status).toBe(200);
    const affordBody = await afford.json();
    expect(affordBody.message.mode).toBe("afford");
    expect(affordBody.message.card.kind).toBe("afford");
    expect(affordBody.message.card.affordability.amountMinor).toBe("5000000");
    expect(affordBody.message.card.keepAtLeastMinor).toMatch(/^\d+$/);
    expect(affordBody.message.card.affordability.inputs.obligations).toBeInstanceOf(Array);
    expect(affordBody.message.card.freedLoans).toEqual([{ lender: "FairMoney", freedPerMonthMinor: "5000000" }]);
    expect(affordBody.message.text).toBe(affordBody.message.card.affordability.headline.replace(/[\u2013\u2014]/g, ", ").replace(/\s+/g, " ").trim());
    expect(affordBody.message.text).not.toMatch(/[\u2013\u2014]/);

    const spent = await post({ question: "Where did my money go this month?" }, token);
    const spentBody = await spent.json();
    expect(spentBody.message.mode).toBe("rules");
    expect(spentBody.message.text).toContain("Cloud AI is not configured");
    expect(spentBody.message.text).toContain("18,450");
    expect(spentBody.message.card).toBeNull();

    const freed = await post({ question: "What did clearing my loans free up?" }, token);
    const freedBody = await freed.json();
    expect(freedBody.message.text).toContain("₦50,000.00 a month");
    expect(freedBody.message.text).toContain("FairMoney");
    expect(freedBody.message.card.freedLoans[0].freedPerMonthMinor).toBe("5000000");

    const payday = await post({ question: "How much is left until payday?" }, token);
    const paydayBody = await payday.json();
    expect(paydayBody.message.text).toContain("₦2,000,000.00");
    expect(paydayBody.message.text).toMatch(/will not guess a date|payday/);
    expect(paydayBody.message.card.cashMinor).toBe("200000000");

    const history = await GET(new Request("http://localhost/api/v1/ask", { headers: { authorization: `Bearer ${token}` } }));
    const messages = (await history.json()).messages;
    expect(messages.map((row: { role: string }) => row.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(messages[1].card.keepAtLeastMinor).toBe(affordBody.message.card.keepAtLeastMinor);

    const streamed = await post({ question: "Can I afford N50k?", stream: true }, token);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    const raw = await streamed.text();
    const chunks = [...raw.matchAll(/^data: (.*)$/gm)].map((hit) => JSON.parse(hit[1]));
    const text = chunks.filter((row) => row.type === "chunk").map((row) => row.text).join("");
    const done = chunks.find((row) => row.type === "done");
    expect(text).toBe(done.message.text);
    expect(done.message.card.affordability.amountMinor).toBe("5000000");

    const stranger = await db.user.create({ data: { email: "ask-mobile-other@test.dev" } });
    const other = (await issueSession(stranger.id)).token;
    const hidden = await GET(new Request("http://localhost/api/v1/ask", { headers: { authorization: `Bearer ${other}` } }));
    expect((await hidden.json()).messages).toEqual([]);
    expect((await post({ question: "Can I afford N50k?" })).status).toBe(401);
  });
});
