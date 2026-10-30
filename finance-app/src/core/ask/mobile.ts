import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { INCOME_CATEGORY } from "../categorize";
import {
  affordabilityJson,
  checkAffordability,
  cleanDescription,
  loadAffordabilityData,
  parseAmountInput,
  type AffordabilityJson,
} from "../affordability";
import { chatForUser } from "../ai/router";
import { ask } from "./answer";

export const ASK_CHIPS = [
  "Can I afford...?",
  "Where did my money go this month?",
  "What did clearing my loans free up?",
  "How much is left until payday?",
] as const;

const CURRENCY = "₦|ngn|naira|n";
/** Amount, including a currency prefix (N50k) or suffix (50k naira). A trailing N must be its own word. */
const AMOUNT = new RegExp(`(?:(?:${CURRENCY})\\s*)?\\d[\\d,]*(?:\\.\\d+)?\\s*(?:k|m|million|thousand)?(?:\\s*(?:₦|ngn|naira|\\bn\\b))?`, "gi");

export type FreedLoan = { lender: string; freedPerMonthMinor: string };

export type AskCard = {
  kind: "afford" | "freed" | "payday";
  affordability?: AffordabilityJson;
  freedLoans?: FreedLoan[];
  keepAtLeastMinor?: string;
  payday?: { on: string; amountMinor: string } | null;
  cashMinor?: string;
  billsDueMinor?: string;
  leftMinor?: string;
};

export type AskMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  mode: string | null;
  createdAt: string;
  card: AskCard | null;
};

function amountToken(raw: string): string {
  return raw
    .replace(/million/gi, "m")
    .replace(/thousand/gi, "k")
    .replace(new RegExp(`^(?:${CURRENCY})\\s*`, "i"), "")
    .replace(new RegExp(`\\s*(?:${CURRENCY}|\\bn\\b)\\s*$`, "i"), "")
    .replace(/\s+/g, "");
}

/** What the purchase is, after the amount and currency words are gone. */
function purchaseDescription(question: string, amountRaw: string): string | undefined {
  const rest = question.replace(amountRaw, " ").replace(/\bcan i afford\b/gi, " ").replace(/[?]/g, " ");
  const stripped = (cleanDescription(rest) ?? "")
    .replace(new RegExp(`^(?:(?:${CURRENCY}|for)\\b\\s*)+`, "i"), "")
    .replace(new RegExp(`(?:\\s+\\b(?:${CURRENCY})\\b)+$`, "i"), "")
    .trim();
  return cleanDescription(stripped);
}

/** Pulls a naira amount out of "Can I afford N50k?". Null when the question is not about affording. */
export function parseAffordAsk(question: string): { amountMinor: bigint; description?: string } | { needAmount: true } | null {
  if (!/\bafford\b/i.test(question)) return null;
  AMOUNT.lastIndex = 0;
  const hits = question.match(AMOUNT) ?? [];
  for (const raw of hits) {
    const amountMinor = parseAmountInput(amountToken(raw));
    if (amountMinor === null) continue;
    const description = purchaseDescription(question, raw);
    return description ? { amountMinor, description } : { amountMinor };
  }
  return { needAmount: true };
}

function plain(text: string): string {
  return text.replace(/[\u2013\u2014]/g, ", ").replace(/\s+/g, " ").trim();
}

function lagosDay(d: Date): string {
  return new Date(d.getTime() + 3600_000).toISOString().slice(0, 10);
}

function cardOf(raw: string | null): AskCard | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AskCard;
  } catch {
    return null;
  }
}

export function toAskMessage(row: { id: string; role: string; text: string; mode: string | null; cardJson: string | null; createdAt: Date }): AskMessage {
  return {
    id: row.id,
    role: row.role === "user" ? "user" : "assistant",
    text: row.text,
    mode: row.mode,
    createdAt: row.createdAt.toISOString(),
    card: cardOf(row.cardJson),
  };
}

export async function listAsk(userId: string, limit = 40): Promise<AskMessage[]> {
  const rows = await db.chatMessage.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.reverse().map(toAskMessage);
}

async function freedLoans(userId: string): Promise<FreedLoan[]> {
  const rows = await db.loanClearedEvent.findMany({ where: { userId }, orderBy: { closedAt: "desc" } });
  return rows.map((row) => ({ lender: row.lender, freedPerMonthMinor: row.freedPerMonthMinor.toString() }));
}

async function answerAfford(userId: string, question: string, now: Date): Promise<{ text: string; mode: string; card: AskCard }> {
  const parsed = parseAffordAsk(question);
  const freed = await freedLoans(userId);
  if (!parsed || "needAmount" in parsed) {
    return {
      mode: "afford",
      text: "Tell me a price, like N50k or 2.5m. Ledger will check it against your bills, your safety buffer and the days ahead.",
      card: { kind: "afford", freedLoans: freed },
    };
  }
  if ((await db.transaction.count({ where: { userId } })) === 0) {
    return {
      mode: "afford",
      text: "Import a statement first so Ledger has your income and spending to go on.",
      card: { kind: "afford", freedLoans: freed },
    };
  }
  const result = await checkAffordability(userId, { amountMinor: parsed.amountMinor, description: parsed.description, horizon: { kind: "month_end" } }, now);
  const json = affordabilityJson(result);
  return {
    mode: "afford",
    text: plain(result.headline),
    card: { kind: "afford", affordability: json, freedLoans: freed, keepAtLeastMinor: result.projection.lowestMinor.toString() },
  };
}

async function answerFreed(userId: string): Promise<{ text: string; mode: string; card: AskCard }> {
  const freed = await freedLoans(userId);
  if (!freed.length) {
    return {
      mode: "rules",
      text: "Ledger has not recorded a cleared loan, so no monthly amount has been freed.",
      card: { kind: "freed", freedLoans: [] },
    };
  }
  const total = freed.reduce((sum, row) => sum + BigInt(row.freedPerMonthMinor), 0n);
  const lines = freed.map((row) => `${row.lender} freed ${formatMoney(BigInt(row.freedPerMonthMinor))} a month`);
  return {
    mode: "rules",
    text: plain(`Clearing loans freed ${formatMoney(total)} a month. ${lines.join(". ")}.`),
    card: { kind: "freed", freedLoans: freed },
  };
}

async function answerPayday(userId: string, now: Date): Promise<{ text: string; mode: string; card: AskCard }> {
  const data = await loadAffordabilityData(userId, now);
  const cash = data.cash?.minor ?? null;
  const pay = data.income
    .filter((item) => item.category === INCOME_CATEGORY && item.nextExpected.getTime() >= now.getTime())
    .sort((a, b) => a.nextExpected.getTime() - b.nextExpected.getTime())[0];
  if (cash === null) {
    return {
      mode: "rules",
      text: "Ledger has no account balance on file, so it cannot say what is left until payday.",
      card: { kind: "payday", payday: null },
    };
  }
  if (!pay) {
    return {
      mode: "rules",
      text: plain(`Ledger has not found a regular payday, so it will not guess a date. Your balance on file is ${formatMoney(cash)}.`),
      card: { kind: "payday", cashMinor: cash.toString(), payday: null },
    };
  }
  const bills = data.obligations
    .filter((item) => item.nextExpected.getTime() <= pay.nextExpected.getTime())
    .reduce((sum, item) => sum + item.amountMinor, 0n);
  const left = cash - bills;
  const card: AskCard = {
    kind: "payday",
    cashMinor: cash.toString(),
    billsDueMinor: bills.toString(),
    leftMinor: left.toString(),
    payday: { on: lagosDay(pay.nextExpected), amountMinor: pay.amountMinor.toString() },
  };
  return {
    mode: "rules",
    text: plain(`Your balance is ${formatMoney(cash)}. Bills due before payday on ${card.payday!.on} come to ${formatMoney(bills)}, so ${formatMoney(cash)} minus ${formatMoney(bills)} leaves ${formatMoney(left)}. The payday itself is about ${formatMoney(pay.amountMinor)}.`),
    card,
  };
}

async function answerOpen(userId: string, question: string, now: Date): Promise<{ text: string; mode: string; card: AskCard | null }> {
  const prior = await db.chatMessage.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 8,
  });
  const history = prior
    .reverse()
    .filter((row) => row.text !== question)
    .slice(-6)
    .map((row) => ({ role: row.role === "assistant" ? "assistant" as const : "user" as const, text: row.text.slice(0, 2000) }));
  const ai = await chatForUser(userId, question, history, { now });
  if (ai?.grounded && ai.text.trim()) {
    return { mode: "ai", text: plain(ai.text), card: null };
  }
  const { facts } = await ask(userId, question, now);
  const note = ai ? "" : "Cloud AI is not configured, so this is the figure from your ledger. ";
  return { mode: "rules", text: plain(note + facts.headline), card: null };
}

/** One Ask turn. Affordability, cleared loans and payday never go to the model. */
export async function replyToAsk(userId: string, question: string, now = new Date()): Promise<AskMessage> {
  const q = plain(question).slice(0, 400);
  if (!q) throw new Error("Type a question first.");
  await db.chatMessage.create({ data: { userId, role: "user", text: q } });

  const lower = q.toLowerCase();
  const answered = /\bafford\b/.test(lower)
    ? await answerAfford(userId, q, now)
    : /clearing my loans|loans free|freed up|loan cleared/.test(lower)
      ? await answerFreed(userId)
      : /until payday|before payday|left until payday/.test(lower)
        ? await answerPayday(userId, now)
        : await answerOpen(userId, q, now);

  const row = await db.chatMessage.create({
    data: {
      userId,
      role: "assistant",
      text: answered.text.slice(0, 4000),
      mode: answered.mode,
      cardJson: answered.card ? JSON.stringify(answered.card) : null,
    },
  });
  return toAskMessage(row);
}

export function chunkAnswer(text: string, size = 80): string[] {
  if (!text) return [""];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}
