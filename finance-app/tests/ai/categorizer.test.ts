import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { importStatement } from "@/core/statement-import";
import { answerQuestion } from "@/core/review";
import { aiClassifier, suggestCategories, type AiRow, type CategorizeLLM } from "@/core/ai/categorizer";
import { rulesClassifier } from "@/core/eval";
import { redactNarration } from "@/core/ai/client";

const STATEMENT = Buffer.from([
  "Trans. Date,Reference,Debits,Credits,Balance,Remarks",
  "01-Sep-2026,R1,,1500000.00,1600000.00,W5WM-MONIE MFB-DEEL INC",
  "02-Sep-2026,R2,250000.00,,1350000.00,Instant Payment Outward 0901234567 MONTHLY TO",
  "03-Sep-2026,R3,120000.00,,1230000.00,Instant Payment Outward 0902 X TO OPAY - CHINEDU EZE",
  "04-Sep-2026,R4,45000.00,,1185000.00,POS PURCHASE SHOPRITE LEKKI",
  "05-Sep-2026,R5,80000.00,,1105000.00,Instant Payment Outward 0903 Y TO KUDA - AMAKA OBI",
].join("\n"));

async function setup(email: string) {
  const u = await db.user.create({ data: { email } });
  await importStatement(u.id, { name: "s.csv", bytes: STATEMENT }, { institution: "GTBank" });
  return u.id;
}

describe("AI categorizer", () => {
  it("only asks about uncertain rows, stores valid answers as suggestions, and changes no transaction", async () => {
    const userId = await setup("ai1@test.dev");
    const before = await db.transaction.findMany({ where: { userId }, orderBy: { id: "asc" } });
    const seen: AiRow[] = [];
    const llm: CategorizeLLM = async (rows) => {
      seen.push(...rows);
      return rows.map((r) => {
        if (r.narration.includes("MONTHLY")) return { id: r.id, category: "Family", subcategory: "Family support", confidence: 0.82, reason: "monthly memo" };
        if (r.counterparty === "Chinedu Eze") return { id: r.id, category: "Income", subcategory: "", confidence: 0.9, reason: "wrong direction" };
        return { id: r.id, category: "Shopping", subcategory: "", confidence: 0.4, reason: "guess" };
      });
    };
    const r = await suggestCategories(userId, { llm });
    expect(r.suggested).toBe(1);
    expect(r.rejected).toBe(2);
    // Shoprite (confident rule) and Deel (income rule) were never sent; long numbers were redacted
    expect(seen.some((n) => /SHOPRITE|DEEL/.test(n.narration))).toBe(false);
    expect(seen.every((n) => !/\d{6,}/.test(n.narration))).toBe(true);
    const monthly = await db.transaction.findFirstOrThrow({ where: { userId, reference: "R2" }, include: { suggestion: true } });
    expect(monthly.suggestion).toMatchObject({ category: "Family", subcategory: "Family support", classificationSource: "ai", status: "pending" });
    // Income suggested on a debit and the low-confidence guess are rejected and recorded so they are not asked again
    const r3 = await db.transaction.findFirstOrThrow({ where: { userId, reference: "R3" }, include: { suggestion: true } });
    expect(r3.suggestion).toMatchObject({ status: "failed", category: null });
    // Not one transaction changed: categories, amounts, dates and balances are as the rules left them
    const after = await db.transaction.findMany({ where: { userId }, orderBy: { id: "asc" } });
    const shape = (t: (typeof before)[number]) => [t.category, t.subcategory, t.classificationSource, t.amountMinor, t.transactionDate.getTime(), t.balanceAfterMinor];
    expect(after.map(shape)).toEqual(before.map(shape));
  });

  it("never asks about the user's own answers", async () => {
    const userId = await setup("ai2@test.dev");
    await answerQuestion(userId, "person", "chinedu eze", "friend");
    const sent: string[] = [];
    const llm: CategorizeLLM = async (rows) => {
      sent.push(...rows.map((r) => r.counterparty ?? ""));
      return rows.map((r) => ({ id: r.id, category: "Business", subcategory: "", confidence: 0.99, reason: "x" }));
    };
    await suggestCategories(userId, { llm });
    expect(sent).not.toContain("Chinedu Eze");
    const r3 = await db.transaction.findFirstOrThrow({ where: { userId, reference: "R3" }, include: { suggestion: true } });
    expect(r3).toMatchObject({ category: "Transfers", classificationSource: "user", suggestion: null });
  });

  it("does nothing until the user switches AI on", async () => {
    const userId = await setup("ai3@test.dev");
    const r = await suggestCategories(userId);
    expect(r).toMatchObject({ asked: 0, suggested: 0 });
    expect(r.stopped).toMatch(/Settings/);
    expect(await db.categorySuggestion.count({ where: { userId } })).toBe(0);
  });

  it("scorecard never shows the model the user's labels", async () => {
    const userId = await setup("ai4@test.dev");
    await answerQuestion(userId, "person", "amaka obi", "family");
    const sentText: string[] = [];
    const llm: CategorizeLLM = async (rows) => {
      sentText.push(JSON.stringify(rows));
      return rows.map((r) => ({ id: r.id, category: "Family", subcategory: "", confidence: 0.9, reason: "x" }));
    };
    const labelled = await db.transaction.findMany({ where: { userId, classificationSource: "user" } });
    const preds = await aiClassifier(userId, rulesClassifier, llm)(labelled.map((t) => ({ id: t.id, description: t.description, type: t.type as "DEBIT" })), []);
    expect(sentText.join(" ")).not.toMatch(/Family support|"category"/);
    expect(preds.get(labelled[0].id)?.category).toBe("Family");
  });

  it("redacts account numbers and session ids", () => {
    expect(redactNarration("Instant Payment Outward 000013260930195954000030144325 TO OPAY")).toBe("Instant Payment Outward # TO OPAY");
  });
});
