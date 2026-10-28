import { describe, expect, it } from "vitest";
import { accountKey, computeFingerprint, isFuzzyMatch, pickStatementAmountMatch, statementCoversDate, type LedgerCandidate } from "@/core/dedup";
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

  it("does not treat a same-day SMS and statement with unrelated narrations as a fuzzy match", () => {
    const statement = asCandidate({
      ...base,
      source: "statement",
      type: "DEBIT",
      amountMinor: 1_000_000n,
      reference: undefined,
      description: "WEB PURCHASE 991122",
      transactionDate: new Date("2026-10-04T00:00:00.000Z"),
      balanceAfterMinor: 4_000_000n,
    });
    const sms: CanonicalTransaction = {
      ...base,
      source: "sms",
      type: "DEBIT",
      amountMinor: 1_000_000n,
      reference: undefined,
      description: "POS ACME MART LEKKI",
      transactionDate: new Date("2026-10-04T19:45:00.000Z"),
      balanceAfterMinor: 5_000_000n,
      sourceTransactionId: "sms-10k",
    };
    expect(isFuzzyMatch(sms, statement)).toBe(false);
    expect(pickStatementAmountMatch(sms, [statement], true)?.id).toBe(statement.id);
  });

  it("matches an evening SMS to a statement value date one Lagos day away, and not a payment a week later", () => {
    const statement = asCandidate({
      ...base,
      source: "statement",
      amountMinor: 1_000_000n,
      reference: undefined,
      description: "WEB PURCHASE 991122",
      transactionDate: new Date("2026-10-04T00:00:00.000Z"),
    });
    const eveningNextLagosDay: CanonicalTransaction = {
      ...base,
      source: "sms",
      amountMinor: 1_000_000n,
      reference: undefined,
      description: "POS ACME MART",
      transactionDate: new Date("2026-10-04T23:30:00.000Z"),
      sourceTransactionId: "sms-late",
    };
    expect(statementCoversDate(new Date("2026-10-04T00:00:00.000Z"), new Date("2026-10-04T00:00:00.000Z"), eveningNextLagosDay.transactionDate)).toBe(true);
    expect(pickStatementAmountMatch(eveningNextLagosDay, [statement], true)?.id).toBe(statement.id);

    const weekLater = { ...eveningNextLagosDay, transactionDate: new Date("2026-10-11T19:00:00.000Z") };
    expect(statementCoversDate(statement.transactionDate, statement.transactionDate, weekLater.transactionDate)).toBe(false);
    expect(pickStatementAmountMatch(weekLater, [statement], false)).toBeUndefined();
    expect(pickStatementAmountMatch(weekLater, [statement], true)).toBeUndefined();
  });

  it("claims one unclaimed statement row and skips a row that already has this alert", () => {
    const sms: CanonicalTransaction = {
      ...base,
      source: "sms",
      amountMinor: 1_000_000n,
      reference: undefined,
      description: "POS ACME MART",
      transactionDate: new Date("2026-10-04T19:00:00.000Z"),
      balanceAfterMinor: 9_000_000n,
      sourceTransactionId: "sms-ambig",
    };
    const closer = asCandidate({ ...sms, source: "statement", description: "ROW A", transactionDate: new Date("2026-10-04T18:00:00.000Z"), sourceTransactionId: "a" }, "tx-a");
    const farther = asCandidate({ ...sms, source: "statement", description: "ROW B", transactionDate: new Date("2026-10-04T08:00:00.000Z"), sourceTransactionId: "b" }, "tx-b");
    expect(pickStatementAmountMatch(sms, [closer, farther], true)?.id).toBe("tx-a");

    const taken = { ...closer, sources: ["statement", "sms"] };
    expect(pickStatementAmountMatch(sms, [taken], true)).toBeUndefined();
    const sameBalance = { ...taken, balanceAfterMinor: sms.balanceAfterMinor };
    expect(pickStatementAmountMatch(sms, [sameBalance], true)?.id).toBe("tx-a");
  });

  it("does not attach a second statement row to an SMS that already has one", () => {
    const sms = asCandidate({
      ...base,
      source: "sms",
      amountMinor: 500_000n,
      reference: undefined,
      description: "POS ACME MART",
      transactionDate: new Date("2026-10-04T17:00:00.000Z"),
      sourceTransactionId: "sms-5k",
    }, "sms-row");
    sms.sources = ["sms", "statement"];
    const second: CanonicalTransaction = {
      ...base,
      source: "statement",
      amountMinor: 500_000n,
      reference: undefined,
      description: "AIRTIME VEND",
      transactionDate: new Date("2026-10-04T18:00:00.000Z"),
      sourceTransactionId: "stmt-5k-b",
    };
    expect(pickStatementAmountMatch(second, [sms], true)).toBeUndefined();
  });

  it("links a PAYMENTDEEL SMS credit to a Deel INC statement/email credit", () => {
    const sms: CanonicalTransaction = {
      ...base,
      source: "sms",
      type: "CREDIT",
      amountMinor: 51_839_025n,
      reference: undefined,
      description: "PAYMENTDEEL INC-WRAMFB-GRP",
      transactionDate: new Date("2026-10-07T10:08:00Z"),
    };
    const statement = asCandidate({
      ...sms,
      source: "statement",
      sourceTransactionId: "stmt-deel",
      description: "W5WM-MONIE MFB-DEEL INC",
      transactionDate: new Date("2026-10-07T00:00:00Z"),
    });
    expect(isFuzzyMatch(sms, statement)).toBe(true);
  });
});
