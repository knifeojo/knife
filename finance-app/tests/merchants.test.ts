import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { categorize } from "@/core/categorize";
import { looksLikePerson } from "@/core/ai/redact";
import { suggestCategories, type CategorizeLLM } from "@/core/ai/categorizer";
import { DIRECTORY, isDirectoryBusiness, matchDirectory } from "@/core/merchants/directory";
import { isRegistryCandidate, type BusinessRegistry } from "@/core/merchants/registry";
import { ingestTransaction } from "@/core/ledger";
import { canonicalLabel } from "@/core/taxonomy";

describe("seeded merchant directory", () => {
  it("every entry uses a real taxonomy pair and a non-empty alias", () => {
    expect(DIRECTORY.version).toBe(1);
    expect(DIRECTORY.merchants.length).toBeGreaterThan(200);
    for (const m of DIRECTORY.merchants) {
      expect(canonicalLabel(m.category, m.subcategory ?? null), `${m.name} ${m.category}/${m.subcategory}`).toEqual({
        category: m.category,
        subcategory: m.subcategory ?? null,
      });
      expect(m.aliases.length).toBeGreaterThan(0);
      expect(m.aliases.every((a) => a === a.toLowerCase() && a.length >= 3)).toBe(true);
    }
  });

  it("matches spaced and run-together Nigerian narrations", () => {
    expect(matchDirectory("POS JENDOL SUPERSTORES LEKKI")?.entry.name).toBe("Jendol Superstores");
    expect(matchDirectory("NIP TO IKEJAELECTRIC PREPAID")?.entry.name).toBe("Ikeja Electric");
    expect(matchDirectory("TRF TO PIGGYVEST SAVINGS")?.entry.name).toBe("PiggyVest");
    expect(matchDirectory("FAIRMONEY MFB LOAN")?.entry.name).toBe("FairMoney");
  });

  it("does not treat a person's name that happens to contain a brand as that business", () => {
    expect(isDirectoryBusiness("Bolaji Jendol Adeyemi")).toBe(false);
    expect(isDirectoryBusiness("Jendol Superstores Ltd")).toBe(true);
    expect(looksLikePerson("Bolaji Jendol Adeyemi")).toBe(true);
    expect(looksLikePerson("Jendol Superstores")).toBe(false);
  });

  it("labels a directory merchant after the hand-written rules, without inventing a person", () => {
    const c = categorize({ description: "Instant Payment Outward TO ZBN - JENDOL SUPERSTORES LTD", type: "DEBIT" });
    expect(c).toMatchObject({ category: "Food", subcategory: "Groceries", merchantName: "Jendol Superstores", source: "rule", confidence: 0.85 });
  });

  it("does not label a transfer to a person whose name contains a directory brand", () => {
    const c = categorize({ description: "Instant Payment Outward TO OPAY - BOLAJI JENDOL ADEYEMI", type: "DEBIT" });
    expect(c.category).toBe("Transfers");
    expect(c.merchantName).not.toBe("Jendol Superstores");
  });

  it("the owner's own rule wins over the directory", () => {
    const c = categorize(
      { description: "Instant Payment Outward TO ZBN - JENDOL SUPERSTORES LTD", type: "DEBIT" },
      [{ pattern: "jendol superstores", canonicalName: "My grocer", category: "Shopping", subcategory: "Vendors" }],
    );
    expect(c).toMatchObject({ category: "Shopping", subcategory: "Vendors", merchantName: "My grocer", source: "user", confidence: 1 });
  });

  it("a wallet only labels a debit that names nobody else", () => {
    expect(categorize({ description: "OPAY WALLET TOP UP", type: "DEBIT" })).toMatchObject({
      category: "Own transfer",
      subcategory: "Wallet top-up",
      merchantName: "OPay",
    });
    expect(categorize({ description: "Instant Payment Outward TO OPAY - TOLU ADE", type: "DEBIT" }).category).toBe("Transfers");
  });

  it("a lender debit is a repayment and a credit is loan proceeds", () => {
    expect(categorize({ description: "NIP TO FAIRMONEY MFB", type: "DEBIT" })).toMatchObject({
      category: "Debt",
      subcategory: "Loan repayment",
      merchantName: "FairMoney",
    });
    // Hand-written lender rules still win when they match; directory covers names they do not.
    expect(categorize({ description: "NIP FROM CREDIT DIRECT LIMITED", type: "CREDIT" })).toMatchObject({
      category: "Debt",
      subcategory: "Loan proceeds",
      merchantName: "Credit Direct",
    });
  });

  it("directory rows stay out of the AI backlog", async () => {
    const u = await db.user.create({ data: { email: "dir-backlog@test.dev" } });
    await ingestTransaction(u.id, {
      institution: "GTBank", source: "statement", sourceTransactionId: "j1", type: "DEBIT", amountMinor: 8_000_000n, currency: "NGN",
      transactionDate: new Date("2026-09-02T10:00:00Z"), description: "Instant Payment Outward TO ZBN - JENDOL SUPERSTORES LTD",
      reference: "J1", accountLast4: undefined, confidence: 1,
    });
    const seen: string[] = [];
    const llm: CategorizeLLM = async (rows) => {
      seen.push(...rows.map((r) => r.narration));
      return [];
    };
    await suggestCategories(u.id, { llm });
    expect(seen.join(" ")).not.toMatch(/jendol/i);
  });
});

describe("business registry hook", () => {
  it("only names ending in a Nigerian legal form are candidates", () => {
    expect(isRegistryCandidate("Acme Ventures Ltd")).toBe(true);
    expect(isRegistryCandidate("Ada Stitches Limited")).toBe(true);
    expect(isRegistryCandidate("Tunde Bello")).toBe(false);
    expect(isRegistryCandidate("Ltd")).toBe(false);
  });

  it("looks up a registered business before any model and stores a pending suggestion", async () => {
    const u = await db.user.create({ data: { email: "registry@test.dev" } });
    await ingestTransaction(u.id, {
      institution: "GTBank", source: "statement", sourceTransactionId: "r1", type: "DEBIT", amountMinor: 12_000_000n, currency: "NGN",
      transactionDate: new Date("2026-09-03T10:00:00Z"), description: "Instant Payment Outward TO OPAY - ACME VENTURES LTD",
      reference: "R1", accountLast4: undefined, confidence: 1,
    });
    let asked = 0;
    const llm: CategorizeLLM = async () => {
      asked++;
      return [];
    };
    const registry: BusinessRegistry = {
      async lookup(name) {
        if (/acme ventures/i.test(name)) return { name: "Acme Ventures Limited", category: "Shopping", subcategory: "Clothing", confidence: 0.8 };
        return undefined;
      },
    };
    const r = await suggestCategories(u.id, { llm, registry });
    expect(r.suggested).toBe(1);
    expect(asked).toBe(0);
    const s = await db.categorySuggestion.findFirstOrThrow({ where: { userId: u.id } });
    expect(s).toMatchObject({ category: "Shopping", subcategory: "Clothing", provider: "registry", status: "pending" });
    const row = await db.transaction.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.category).toBe("Transfers"); // nothing applied until the owner confirms
  });
});
