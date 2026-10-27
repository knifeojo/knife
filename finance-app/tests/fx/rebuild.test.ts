import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { convertToNgn, loadFxContext } from "@/core/fx/rates";
import { rebuildUserFx } from "@/core/fx/realised";
import { buildQuestions } from "@/core/review";

let n = 0;
async function setup() {
  const u = await db.user.create({ data: { email: `fx-rebuild-${++n}@test.dev` } });
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
  data: { type: "DEBIT" | "CREDIT"; amountMinor: bigint; currency: string; date: string; description: string; pairId?: string },
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
      counterparty: "Ada Eze",
      category: data.currency === "NGN" ? "Income" : "Own transfer",
      subcategory: data.currency === "NGN" ? "Transfer" : "Currency conversion",
      classificationSource: "pair",
      classificationConfidence: 0.9,
      transferPairId: data.pairId,
    },
  });
}

async function linkPair(
  userId: string,
  usdAccount: string,
  ngnAccount: string,
  data: { usdMinor: bigint; ngnMinor: bigint; date: string; currency?: string },
) {
  const debit = await row(userId, usdAccount, {
    type: "DEBIT",
    amountMinor: data.usdMinor,
    currency: data.currency ?? "USD",
    date: data.date,
    description: "Money transfer to ADA EZE / Guaranty Trust Bank",
  });
  const credit = await row(userId, ngnAccount, {
    type: "CREDIT",
    amountMinor: data.ngnMinor,
    currency: "NGN",
    date: data.date,
    description: "0001-ADA EZE-PESAPEER LTD",
  });
  await db.transaction.update({ where: { id: debit.id }, data: { transferPairId: credit.id } });
  await db.transaction.update({ where: { id: credit.id }, data: { transferPairId: debit.id } });
  return { debit, credit };
}

async function market(date: string, base: string, rate: number) {
  return db.fxRate.upsert({
    where: { userId_date_base_quote_source: { userId: "", date, base, quote: "NGN", source: "market" } },
    create: { userId: "", date, base, quote: "NGN", rate, source: "market" },
    update: { rate },
  });
}

describe("FX rebuild from existing pairs", () => {
  it("backfills realised rates from pre-existing linked pairs that never wrote FxRate", async () => {
    const { userId, usd, ngn } = await setup();
    await linkPair(userId, usd.id, ngn.id, { usdMinor: 100_00n, ngnMinor: 155_000_00n, date: "2026-09-20" });
    await linkPair(userId, usd.id, ngn.id, { usdMinor: 80_00n, ngnMinor: 124_000_00n, date: "2026-09-22" });
    expect(await db.fxRate.count({ where: { userId, source: "realised" } })).toBe(0);

    const r = await rebuildUserFx(userId);
    expect(r.realised).toBe(2);
    expect(r.rejected).toBe(0);
    const rows = await db.fxRate.findMany({ where: { userId, source: "realised" }, orderBy: { date: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: "2026-09-20", base: "USD", rate: 1550 });
    expect(rows[1]).toMatchObject({ date: "2026-09-22", base: "USD", rate: 1550 });
    expect(await rebuildUserFx(userId)).toMatchObject({ realised: 2, rejected: 0 });
  });

  it("rejects an outlier pair and does not use it as a rate", async () => {
    const { userId, usd, ngn } = await setup();
    await market("2026-09-24", "USD", 1500);
    const bad = await linkPair(userId, usd.id, ngn.id, { usdMinor: 40_00n, ngnMinor: 120_000_00n, date: "2026-09-24" });
    await linkPair(userId, usd.id, ngn.id, { usdMinor: 100_00n, ngnMinor: 150_000_00n, date: "2026-09-24" });

    const r = await rebuildUserFx(userId);
    expect(r.rejected).toBe(1);
    const fx = await db.fxRate.findMany({ where: { userId, source: "realised" } });
    expect(fx).toHaveLength(1);
    expect(fx[0].rate).toBe(1500);
    const leftover = await db.transaction.findUniqueOrThrow({ where: { id: bad.debit.id } });
    expect(leftover.transferPairId).toBeNull();
    const qs = await buildQuestions(userId);
    expect(qs.some((q) => q.kind === "mispair")).toBe(true);
  });

  it("stores the amount-weighted average when several pairs fall on the same day", async () => {
    const { userId, usd, ngn } = await setup();
    await market("2026-09-18", "USD", 1500);
    await linkPair(userId, usd.id, ngn.id, { usdMinor: 100_00n, ngnMinor: 150_000_00n, date: "2026-09-18" });
    await linkPair(userId, usd.id, ngn.id, { usdMinor: 50_00n, ngnMinor: 80_000_00n, date: "2026-09-18" });

    await rebuildUserFx(userId);
    const fx = await db.fxRate.findFirstOrThrow({ where: { userId, source: "realised", date: "2026-09-18" } });
    expect(fx.rate).toBeCloseTo(230_000 / 150, 8);
  });

  it("converts a large credit near an outlier date at the sane rate", async () => {
    const { userId, usd, ngn } = await setup();
    await market("2026-09-24", "USD", 1500);
    await linkPair(userId, usd.id, ngn.id, { usdMinor: 40_00n, ngnMinor: 120_000_00n, date: "2026-09-24" });

    await rebuildUserFx(userId);
    expect(await db.fxRate.count({ where: { userId, source: "realised" } })).toBe(0);
    const ctx = await loadFxContext(userId);
    const hit = convertToNgn(ctx, 6000_00n, "USD", new Date("2026-09-26T12:00:00Z"));
    expect(hit).toMatchObject({ rate: 1500, source: "market" });
    expect(hit!.nairaMinor).toBe(9_000_000_00n);
  });

  it("uses a quoted payout rate on an unpaired wallet row", async () => {
    const { userId, usd } = await setup();
    await market("2026-10-04", "USD", 1500);
    await db.transaction.create({
      data: {
        userId,
        accountId: usd.id,
        source: "fixture",
        sourceTransactionId: fp(),
        fingerprint: fp(),
        transactionDate: new Date("2026-10-04T12:00:00Z"),
        type: "DEBIT",
        amountMinor: 100_00n,
        currency: "USD",
        description: "USD wallet payout @ 1550 NGN / Guaranty Trust Bank",
        counterparty: "Ada Eze",
        category: "Own transfer",
        subcategory: "Currency conversion",
        classificationSource: "rule",
        classificationConfidence: 0.9,
      },
    });

    const r = await rebuildUserFx(userId);
    expect(r.realised).toBe(1);
    const fx = await db.fxRate.findFirstOrThrow({ where: { userId, source: "realised", date: "2026-10-04" } });
    expect(fx).toMatchObject({ base: "USD", rate: 1550 });
    const ctx = await loadFxContext(userId);
    expect(convertToNgn(ctx, 40_00n, "USD", new Date("2026-10-05T12:00:00Z"))).toMatchObject({ rate: 1550, source: "realised" });
  });

  it("matches a next-day Deel withdrawal to the naira landing", async () => {
    const { userId, usd, ngn } = await setup();
    await market("2026-10-06", "USD", 1500);
    await db.transaction.create({
      data: {
        userId,
        accountId: usd.id,
        source: "fixture",
        sourceTransactionId: fp(),
        fingerprint: fp(),
        transactionDate: new Date("2026-10-05T12:00:00Z"),
        type: "DEBIT",
        amountMinor: 100_00n,
        currency: "USD",
        description: "Money transfer to Ada Eze / Deel withdrawal",
        counterparty: "Ada Eze",
        category: "Own transfer",
        subcategory: "Currency conversion",
        classificationSource: "rule",
        classificationConfidence: 0.9,
      },
    });
    await db.transaction.create({
      data: {
        userId,
        accountId: ngn.id,
        source: "fixture",
        sourceTransactionId: fp(),
        fingerprint: fp(),
        transactionDate: new Date("2026-10-06T09:00:00Z"),
        type: "CREDIT",
        amountMinor: 154_000_00n,
        currency: "NGN",
        description: "NIP CREDIT DEEL INC",
        counterparty: "DEEL INC",
        category: "Income",
        subcategory: "Transfer",
        classificationSource: "rule",
        classificationConfidence: 0.9,
      },
    });

    const r = await rebuildUserFx(userId);
    expect(r.realised).toBe(1);
    const fx = await db.fxRate.findFirstOrThrow({ where: { userId, source: "realised" } });
    expect(fx).toMatchObject({ date: "2026-10-06", base: "USD", rate: 1540 });
  });

  it("uses the day's amount-weighted aggregate when same-day withdrawals are ambiguous", async () => {
    const { userId, usd, ngn } = await setup();
    await market("2026-10-08", "USD", 1500);
    const debit = async (id: string) =>
      db.transaction.create({
        data: {
          userId,
          accountId: usd.id,
          source: "fixture",
          sourceTransactionId: fp(),
          fingerprint: fp(),
          transactionDate: new Date("2026-10-08T11:00:00Z"),
          type: "DEBIT",
          amountMinor: 100_00n,
          currency: "USD",
          description: `Money transfer to Ada Eze / Deel withdrawal ${id}`,
          counterparty: "Ada Eze",
          category: "Own transfer",
          subcategory: "Currency conversion",
          classificationSource: "rule",
          classificationConfidence: 0.9,
        },
      });
    const credit = async (ngnMinor: bigint, tag: string) =>
      db.transaction.create({
        data: {
          userId,
          accountId: ngn.id,
          source: "fixture",
          sourceTransactionId: fp(),
          fingerprint: fp(),
          transactionDate: new Date("2026-10-08T14:00:00Z"),
          type: "CREDIT",
          amountMinor: ngnMinor,
          currency: "NGN",
          description: `NIP CREDIT DEEL INC ${tag}`,
          counterparty: "DEEL INC",
          category: "Income",
          subcategory: "Transfer",
          classificationSource: "rule",
          classificationConfidence: 0.9,
        },
      });
    await debit("a");
    await debit("b");
    await credit(150_000_00n, "one");
    await credit(160_000_00n, "two");

    await rebuildUserFx(userId);
    const fx = await db.fxRate.findFirstOrThrow({ where: { userId, source: "realised", date: "2026-10-08" } });
    expect(fx.rate).toBeCloseTo(310_000 / 200, 8);
  });

  it("retags a USD-labeled pair whose rate matches CAD", async () => {
    const { userId, usd, ngn } = await setup();
    await market("2026-09-28", "USD", 1500);
    await market("2026-09-28", "CAD", 960);
    const { debit } = await linkPair(userId, usd.id, ngn.id, {
      usdMinor: 100_00n, ngnMinor: 96_400_00n, date: "2026-09-28", currency: "USD",
    });

    const r = await rebuildUserFx(userId);
    expect(r.retagged).toBe(1);
    expect((await db.transaction.findUniqueOrThrow({ where: { id: debit.id } })).currency).toBe("CAD");
    const fx = await db.fxRate.findFirstOrThrow({ where: { userId, source: "realised" } });
    expect(fx).toMatchObject({ base: "CAD" });
    expect(fx.rate).toBeCloseTo(964, 5);
  });
});
