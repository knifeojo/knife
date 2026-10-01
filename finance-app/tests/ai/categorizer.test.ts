import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { importStatement } from "@/core/statement-import";
import { answerQuestion } from "@/core/review";
import { aiCategorize, aiClassifier, type CategorizeLLM } from "@/core/ai/categorizer";
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
  it("only asks about uncertain rows, applies valid answers, and never changes amounts", async () => {
    const userId = await setup("ai1@test.dev");
    const before = await db.transaction.findMany({ where: { userId }, orderBy: { id: "asc" } });
    const seen: string[] = [];
    const llm: CategorizeLLM = async (rows) => {
      seen.push(...rows.map((r) => r.narration));
      return rows.map((r) => {
        if (r.narration.includes("MONTHLY")) return { id: r.id, category: "Family", subcategory: "Allowance", confidence: 0.82, reason: "monthly memo" };
        if (r.payee === "Chinedu Eze") return { id: r.id, category: "Income", subcategory: null, confidence: 0.9, reason: "wrong direction" };
        return { id: r.id, category: "Shopping", subcategory: null, confidence: 0.4, reason: "guess" };
      });
    };
    const r = await aiCategorize(userId, { llm });
    expect(r.updated).toBe(1);
    // Shoprite (confident rule) and Deel (income rule) were never sent; long numbers were redacted
    expect(seen.some((n) => /SHOPRITE|DEEL/.test(n))).toBe(false);
    expect(seen.every((n) => !/\d{6,}/.test(n))).toBe(true);
    const monthly = await db.transaction.findFirstOrThrow({ where: { userId, reference: "R2" } });
    expect(monthly).toMatchObject({ category: "Family", subcategory: "Allowance", classificationSource: "ai" });
    expect(monthly.classificationConfidence).toBeLessThanOrEqual(0.85);
    // Income suggested on a debit rejected; low confidence rejected
    expect((await db.transaction.findFirstOrThrow({ where: { userId, reference: "R3" } })).category).toBe("Transfers");
    expect((await db.transaction.findFirstOrThrow({ where: { userId, reference: "R5" } })).category).toBe("Transfers");
    const after = await db.transaction.findMany({ where: { userId }, orderBy: { id: "asc" } });
    expect(after.map((t) => [t.amountMinor, t.transactionDate.getTime(), t.balanceAfterMinor])).toEqual(
      before.map((t) => [t.amountMinor, t.transactionDate.getTime(), t.balanceAfterMinor]),
    );
  });

  it("never overrides the user's own answers", async () => {
    const userId = await setup("ai2@test.dev");
    await answerQuestion(userId, "person", "chinedu eze", "friend");
    const llm: CategorizeLLM = async (rows) => rows.map((r) => ({ id: r.id, category: "Business", subcategory: null, confidence: 0.99, reason: "x" }));
    await aiCategorize(userId, { llm });
    expect((await db.transaction.findFirstOrThrow({ where: { userId, reference: "R3" } })).category).toBe("Transfers");
    expect((await db.transaction.findFirstOrThrow({ where: { userId, reference: "R3" } })).classificationSource).toBe("user");
  });

  it("does nothing without consent and a key", async () => {
    const userId = await setup("ai3@test.dev");
    expect(await aiCategorize(userId)).toEqual({ asked: 0, updated: 0 });
  });

  it("scorecard withholds the user's label for the name being scored", async () => {
    const userId = await setup("ai4@test.dev");
    await answerQuestion(userId, "person", "amaka obi", "family");
    let examplesSeen: string[] = [];
    const llm: CategorizeLLM = async (rows, ctx) => {
      examplesSeen = ctx.examples.map((e) => e.name.toLowerCase());
      return rows.map((r) => ({ id: r.id, category: "Family", subcategory: null, confidence: 0.9, reason: "x" }));
    };
    const labelled = await db.transaction.findMany({ where: { userId, classificationSource: "user" } });
    const preds = await aiClassifier(userId, rulesClassifier, llm)(labelled.map((t) => ({ id: t.id, description: t.description, type: t.type as "DEBIT" })), []);
    expect(examplesSeen).not.toContain("amaka obi");
    expect(preds.get(labelled[0].id)?.category).toBe("Family");
  });

  it("redacts account numbers and session ids", () => {
    expect(redactNarration("Instant Payment Outward 000013260930195954000030144325 TO OPAY")).toBe("Instant Payment Outward # TO OPAY");
  });
});
