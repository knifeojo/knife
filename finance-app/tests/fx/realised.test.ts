import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { convertToNgn, loadFxContext } from "@/core/fx/rates";
import { findPairs, pairOwnTransfers } from "@/core/transfers";
import { ingestTransaction } from "@/core/ledger";
import { monthPeriod, summary } from "@/core/analytics";

let n = 0;
async function setup() {
  const u = await db.user.create({ data: { email: `fx-real-${++n}@test.dev` } });
  const usd = await db.account.create({
    data: { userId: u.id, institution: "Pesa", accountName: "Pesa USD", maskedAccountNumber: "****1111", holderName: "Ada Eze", currency: "USD" },
  });
  const ngn = await db.account.create({
    data: { userId: u.id, institution: "GTBank", accountName: "GTB NGN", maskedAccountNumber: "****2222", holderName: "Ada Eze", currency: "NGN" },
  });
  return { userId: u.id, usd, ngn };
}

function fp() {
  return `fp-${++n}-${Math.random().toString(16).slice(2)}`;
}

async function row(
  userId: string,
  accountId: string,
  data: { type: "DEBIT" | "CREDIT"; amountMinor: bigint; currency: string; date: string; description: string; category?: string; counterparty?: string },
) {
  return db.transaction.create({
    data: {
      userId,
      accountId,
      source: "fixture",
      sourceTransactionId: fp(),
      fingerprint: fp(),
      transactionDate: new Date(`${data.date}T12:00:00Z`),
      type: data.type,
      amountMinor: data.amountMinor,
      currency: data.currency,
      description: data.description,
      counterparty: data.counterparty ?? "Ada Eze",
      category: data.category ?? (data.currency === "USD" ? "Own transfer" : "Income"),
      subcategory: data.category === "Own transfer" ? "Between own accounts" : "Transfer",
      classificationSource: "rule",
      classificationConfidence: 0.9,
    },
  });
}

describe("pairing-derived realised rates", () => {
  it("pairs a single own-name USD debit with the next-day NGN credit and stores the effective rate", async () => {
    const { userId, usd, ngn } = await setup();
    const debit = await row(userId, usd.id, {
      type: "DEBIT", amountMinor: 100_00n, currency: "USD", date: "2026-09-24",
      description: "Money transfer to ADA EZE / 0001234533 / Guaranty Trust Bank",
      category: "Own transfer", counterparty: "Ada Eze",
    });
    const credit = await row(userId, ngn.id, {
      type: "CREDIT", amountMinor: 155_000_00n, currency: "NGN", date: "2026-09-25",
      description: "0001-ADA EZE-110059-PESAPEER LTD",
      category: "Income", counterparty: "Ada Eze",
    });
    expect(await pairOwnTransfers(userId)).toBeGreaterThanOrEqual(1);
    const linked = await db.transaction.findUniqueOrThrow({ where: { id: debit.id } });
    expect(linked.transferPairId).toBe(credit.id);
    const fx = await db.fxRate.findFirst({ where: { userId, source: "realised", base: "USD", quote: "NGN" } });
    expect(fx).toMatchObject({ rate: 1550, date: "2026-09-25" });
    const ctx = await loadFxContext(userId);
    const near = convertToNgn(ctx, 40_00n, "USD", new Date("2026-09-27T12:00:00Z"));
    expect(near).toMatchObject({ rate: 1550, source: "realised" });
    expect(near!.nairaMinor).toBe(62_000_00n);
  });

  it("does not invent a pair without the owner's name or an own-transfer label", () => {
    const debit = {
      id: "d", accountId: "usd", institution: "Pesa", type: "DEBIT", amountMinor: 100_00n, currency: "USD",
      transactionDate: new Date("2026-09-24T12:00:00Z"), description: "Money transfer to KOFI MENSAH / +233201234567 / MTN",
      counterparty: "Kofi Mensah", category: "Transfers", classificationSource: "default",
    };
    const credit = {
      id: "c", accountId: "ngn", institution: "GTBank", type: "CREDIT", amountMinor: 155_000_00n, currency: "NGN",
      transactionDate: new Date("2026-09-24T14:00:00Z"), description: "NIP FROM SOMEONE",
      counterparty: "Someone", category: "Income", classificationSource: "default",
    };
    expect(findPairs([debit, credit], ["Ada Eze"])).toHaveLength(0);
  });

  it("nets a reversed payout out of spending and income", async () => {
    const { userId, usd } = await setup();
    await row(userId, usd.id, {
      type: "DEBIT", amountMinor: 40_00n, currency: "USD", date: "2026-10-01",
      description: "Money transfer to JOHN DOE / payout", category: "Transfers", counterparty: "John Doe",
    });
    await row(userId, usd.id, {
      type: "CREDIT", amountMinor: 40_00n, currency: "USD", date: "2026-10-03",
      description: "Payout of $40.00 was successfully reversed", category: "Transfers", counterparty: undefined,
    });
    expect(await pairOwnTransfers(userId)).toBe(1);
    const rows = await db.transaction.findMany({ where: { userId, amountMinor: 40_00n } });
    expect(rows.every((r) => r.transferPairId && r.subcategory === "Reversal")).toBe(true);
    const s = await summary(userId, monthPeriod(new Date("2026-10-15T12:00:00Z")));
    expect(s.income).toBe(0n);
    expect(s.expenses).toBe(0n);
  });

  it("stores a Deel quoted NGN proceeds as a realised rate on ingest", async () => {
    const { userId, usd } = await setup();
    await ingestTransaction(userId, {
      institution: "Pesa",
      source: "statement",
      sourceTransactionId: "deel-1",
      type: "DEBIT",
      amountMinor: 1250_00n,
      currency: "USD",
      transactionDate: new Date("2026-09-10T12:00:00Z"),
      description: "Deel withdrawal",
      fxQuoteCurrency: "NGN",
      fxQuoteMinor: 1_937_500_00n,
      accountLast4: "1111",
      confidence: 1,
    });
    const fx = await db.fxRate.findFirst({ where: { userId, source: "realised", base: "USD" } });
    expect(fx?.rate).toBeCloseTo(1550, 5);
    const ctx = await loadFxContext(userId);
    expect(convertToNgn(ctx, 10_00n, "USD", new Date("2026-09-12T12:00:00Z"))?.rate).toBeCloseTo(1550, 5);
  });
});
