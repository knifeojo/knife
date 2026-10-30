import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { importStatement } from "@/core/statement-import";
import { createPerson } from "@/core/people";
import { Redactor, redactorFor } from "@/core/ai/redact";
import { cloudCategorizeLLM, ollamaCategorizeLLM, promptFor, suggestCategories, type AiRow, type CategorizeContext, type CategorizeLLM } from "@/core/ai/categorizer";
import { reviewWithSuggestions } from "@/core/ai/suggestions";
import type { AiConfig } from "@/core/ai/client";
import type { Fetch } from "@/core/ai/ollama";

const LOCAL: AiConfig = { provider: "ollama", model: "qwen2.5:3b", baseUrl: "http://localhost:11434", cloud: false };
const ROW: AiRow = { id: "1", date: "2026-09-02", direction: "out", amount: "₦150,000.00", narration: "NIP TRANSFER TO PALMPAY - OKEKE AMAKA C", counterparty: "Okeke Amakac" };
const WIFE: CategorizeContext = { people: [{ names: ["Amaka Chinwe Okeke", "Okeke Amakac"], relationship: "spouse" }] };

describe("redaction with relationship labels", () => {
  it("sends known people as PERSON_n (relationship) and restores the name locally", () => {
    const r = new Redactor({ owners: ["Eze Ada Bello"], known: [{ names: ["Amaka Chinwe Okeke", "Okeke Amakac"], relationship: "spouse" }, { names: ["Tunde Okeke"], relationship: "sibling" }] });
    const out = r.text("TO OPAY - AMAKA CHINWE OKEKE; FROM EZE ADA BELLO TO TUNDE OKEKE; TO OKEKE AMAKAC");
    expect(out).toBe("TO OPAY - PERSON_1 (spouse); FROM OWNER TO PERSON_2 (sibling); TO PERSON_1 (spouse)");
    expect(out).not.toMatch(/amaka|okeke|tunde|chinwe/i);
    expect(r.restore("PERSON_1 (spouse) gets weekly support; PERSON_2 is a sibling")).toBe("Amaka Chinwe Okeke gets weekly support; Tunde Okeke is a sibling");
    expect(r.placeholderOfName("Amaka Chinwe Okeke")).toBe("PERSON_1 (spouse)");
  });

  it("redactorFor labels the owner's people, and 'me' is the owner", async () => {
    const u = await db.user.create({ data: { email: "ctx-redactor@test.dev", name: "Eze Ada Bello" } });
    await createPerson(u.id, { displayName: "Amaka Chinwe Okeke", relationship: "spouse", aliases: ["OKEKE AMAKA C"] });
    await createPerson(u.id, { displayName: "Ada Bello Eze", relationship: "me" });
    const r = await redactorFor(u.id);
    expect(r.text("TO OPAY - OKEKE AMAKA CHINWE")).toBe("TO OPAY - PERSON_1 (spouse)");
    expect(r.text("TO KUDA - ADA BELLO EZE")).toBe("TO KUDA - OWNER");
  });
});

describe("known people in the categorizer prompt", () => {
  it("lists them before the transactions, by name locally", async () => {
    expect(promptFor([ROW], WIFE)).toMatch(/Known people:\n- Amaka Chinwe Okeke \(also Okeke Amakac\): spouse\n\nTransactions:\n/);
    expect(promptFor([ROW])).not.toMatch(/Known people/);
    const bodies: string[] = [];
    const fetch: Fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      return Response.json({ message: { role: "assistant", content: JSON.stringify({ suggestions: [] }) } });
    };
    await ollamaCategorizeLLM({ config: LOCAL, fetch })([ROW], WIFE);
    expect(bodies[0]).toContain("Amaka Chinwe Okeke (also Okeke Amakac): spouse");
  });

  it("never sends a real name to the cloud: only the labelled placeholder", async () => {
    const sent: string[] = [];
    const create = (async (p: unknown) => {
      sent.push(JSON.stringify(p));
      return { content: [{ type: "text", text: JSON.stringify({ suggestions: [{ id: "1", category: "Family", subcategory: "Spouse", confidence: 0.9, reason: "PERSON_1 (spouse) support" }] }) }], stop_reason: "end_turn" };
    }) as never;
    const out = await cloudCategorizeLLM({ create })([ROW], WIFE);
    expect(sent[0]).toContain("Known people:\\n- PERSON_1 (spouse)");
    expect(sent[0]).toContain("PALMPAY - PERSON_1 (spouse)");
    expect(sent[0]).not.toMatch(/\b(amaka|gifta|chinwe|okeke)\b/i);
    expect(out).toEqual([expect.objectContaining({ reason: "Amaka Chinwe Okeke support" })]);
  });

  it("suggestCategories passes the people a batch names, and nobody else", async () => {
    const u = await db.user.create({ data: { email: "ctx-suggest@test.dev" } });
    const csv = Buffer.from(["Trans. Date,Reference,Debits,Credits,Balance,Remarks",
      "02-Sep-2026,C1,100000.00,,900000.00,Instant Payment Outward 01 TO OPAY - TUNDE OKEKE",
      "03-Sep-2026,C2,50000.00,,850000.00,Instant Payment Outward 02 TO OPAY - CHIDI OKAFOR"].join("\n"));
    await importStatement(u.id, { name: "s.csv", bytes: csv }, { institution: "GTBank" });
    await createPerson(u.id, { displayName: "Tunde Adewale Okeke", relationship: "sibling" });
    await createPerson(u.id, { displayName: "Tunde Bello Okeke", relationship: "friend" });
    await createPerson(u.id, { displayName: "Amaka Chinwe Okeke", relationship: "spouse" });
    const seen: (CategorizeContext | undefined)[] = [];
    const llm: CategorizeLLM = async (rows, ctx) => (seen.push(ctx), []);
    await suggestCategories(u.id, { llm, config: LOCAL, escalate: false, batchSize: 1 });
    const tunde = seen.find((c) => c?.people?.length);
    expect(tunde?.people?.map((p) => `${p.names[0]}: ${p.relationship}`).sort()).toEqual(["Tunde Adewale Okeke: sibling", "Tunde Bello Okeke: friend"]);
    expect(JSON.stringify(seen)).not.toContain("Amaka");
  });
});

describe("the AI proposes a relationship, the owner confirms", () => {
  it("shows the relationship the AI's label implies on the Who question, without changing anything", async () => {
    const u = await db.user.create({ data: { email: "ctx-propose@test.dev" } });
    const csv = Buffer.from(["Trans. Date,Reference,Debits,Credits,Balance,Remarks",
      "02-Aug-2026,A1,100000.00,,900000.00,Instant Payment Outward 01 TO OPAY - CHIDI OKAFOR",
      "02-Sep-2026,A2,100000.00,,800000.00,Instant Payment Outward 02 TO OPAY - CHIDI OKAFOR"].join("\n"));
    await importStatement(u.id, { name: "s.csv", bytes: csv }, { institution: "GTBank" });
    const llm: CategorizeLLM = async (rows) => rows.map((r) => ({ id: r.id, category: "Family", subcategory: "Siblings", confidence: 0.8, reason: "regular support" }));
    await suggestCategories(u.id, { llm, config: LOCAL, escalate: false });
    const { questions } = await reviewWithSuggestions(u.id);
    const q = questions.find((x) => x.key === "chidi okafor")!;
    expect(q).toMatchObject({ kind: "person", aiRelationship: "sibling" });
    expect(await db.person.count({ where: { userId: u.id } })).toBe(0);
    expect((await db.transaction.findMany({ where: { userId: u.id } })).every((t) => t.category !== "Family")).toBe(true);
  });
});
