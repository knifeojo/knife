import { describe, expect, it } from "vitest";
import { accountKey, computeFingerprint, isFuzzyMatch, type LedgerCandidate } from "@/core/dedup";
import type { CanonicalTransaction } from "@/core/types";

const base: CanonicalTransaction = {
  institution: "GTBank",
  source: "gmail",
  sourceTransactionId: "msg-1",
  type: "DEBIT",
  amountMinor: 25_000_000n,
  currency: "NGN",
  transactionDate: new Date("2026-09-25T09:14:52Z"),
  description: "Transfer to Seun",
  reference: "ABC123",
  accountLast4: "4521",
  confidence: 1,
};

const asCandidate = (t: CanonicalTransaction, id = "tx1"): LedgerCandidate => ({
  id,
  source: t.source,
  accountKey: accountKey(t.institution, t.accountLast4),
  currency: t.currency,
  type: t.type,
  amountMinor: t.amountMinor,
  transactionDate: t.transactionDate,
  description: t.description,
  reference: t.reference,
});

describe("fingerprint", () => {
  it("is identical for the same alert delivered twice", () => {
    expect(computeFingerprint(base)).toBe(computeFingerprint({ ...base, sourceTransactionId: "msg-2" }));
  });

  it("matches email and statement when both carry the bank reference, even a day apart", () => {
    const statement = { ...base, source: "statement" as const, description: "TRF SEUN", transactionDate: new Date("2026-09-26T00:00:00Z") };
    expect(computeFingerprint(statement)).toBe(computeFingerprint(base));
  });

  it("keeps two identical same-day purchases without references apart via balance-after", () => {
    const a = { ...base, reference: undefined, description: "UBER TRIP", amountMinor: 500_000n, balanceAfterMinor: 1_000_000n };
    const b = { ...a, sourceTransactionId: "msg-3", balanceAfterMinor: 500_000n };
    expect(computeFingerprint(a)).not.toBe(computeFingerprint(b));
  });

  it("differs when amount differs", () => {
    expect(computeFingerprint({ ...base, amountMinor: 25_000_001n })).not.toBe(computeFingerprint(base));
  });
});

describe("fuzzy cross-source matching", () => {
  it("matches the prompt's example: email 'Transfer to Seun Ref ABC123' vs statement 'TRF SEUN ABC123'", () => {
    const email = asCandidate(base);
    const statement: CanonicalTransaction = {
      ...base,
      source: "statement",
      sourceTransactionId: "stmt-row-8",
      description: "TRF SEUN ABC123",
      reference: undefined,
      transactionDate: new Date("2026-09-25T00:00:00Z"),
    };
    expect(isFuzzyMatch(statement, email)).toBe(true);
  });

  it("matches open banking rows with similar narration and no reference", () => {
    const email = asCandidate({ ...base, reference: undefined, description: "POS PURCHASE SHOPRITE LEKKI LAGOS" });
    const mono: CanonicalTransaction = { ...base, source: "mono", reference: undefined, description: "SHOPRITE LEKKI", sourceTransactionId: "mono-1" };
    expect(isFuzzyMatch(mono, email)).toBe(true);
  });

  it("never fuzzy-merges within the same source", () => {
    const a = asCandidate({ ...base, reference: undefined, description: "UBER TRIP" });
    expect(isFuzzyMatch({ ...base, reference: undefined, description: "UBER TRIP", sourceTransactionId: "msg-9" }, a)).toBe(false);
  });

  it("rejects different amounts, directions and far-apart dates", () => {
    const c = asCandidate(base);
    const s = { ...base, source: "statement" as const };
    expect(isFuzzyMatch({ ...s, amountMinor: 1n }, c)).toBe(false);
    expect(isFuzzyMatch({ ...s, type: "CREDIT" }, c)).toBe(false);
    expect(isFuzzyMatch({ ...s, transactionDate: new Date("2026-09-28T09:00:00Z") }, c)).toBe(false);
  });

  it("rejects conflicting references", () => {
    expect(isFuzzyMatch({ ...base, source: "statement", reference: "ZZZ999" }, asCandidate(base))).toBe(false);
  });
});
