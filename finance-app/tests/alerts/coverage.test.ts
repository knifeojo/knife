import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { backfillStatementCoverage } from "@/core/alerts/coverage";
import { applySmsStatementLinks, formatLinkLine, planSmsStatementLinks } from "@/core/alerts/link-sms";

describe("statement coverage backfill and SMS link cleanup", () => {
  it("sets coverage from statement rows only, and does not open review flags", async () => {
    const user = await db.user.create({ data: { email: "coverage-backfill@test.dev" } });
    const account = await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTBank ••1234", maskedAccountNumber: "****1234", currency: "NGN" },
    });
    const early = new Date("2026-10-01T11:00:00.000Z");
    const late = new Date("2026-10-20T11:00:00.000Z");
    await db.transaction.create({
      data: {
        userId: user.id, accountId: account.id, source: "statement", sourceTransactionId: "cov-a", fingerprint: "cov-a",
        transactionDate: early, type: "DEBIT", amountMinor: 100_000n, currency: "NGN",
        description: "A", category: "Other", classificationSource: "rule", classificationConfidence: 1,
      },
    });
    await db.transaction.create({
      data: {
        userId: user.id, accountId: account.id, source: "statement", sourceTransactionId: "cov-b", fingerprint: "cov-b",
        transactionDate: late, type: "CREDIT", amountMinor: 200_000n, currency: "NGN",
        description: "B", category: "Other", classificationSource: "rule", classificationConfidence: 1,
      },
    });
    await db.transaction.create({
      data: {
        userId: user.id, accountId: account.id, source: "sms", sourceTransactionId: "cov-sms", fingerprint: "cov-sms",
        transactionDate: new Date("2026-09-01T11:00:00.000Z"), type: "DEBIT", amountMinor: 50_000n, currency: "NGN",
        description: "Earlier alert", category: "Other", classificationSource: "rule", classificationConfidence: 1,
      },
    });

    const first = await backfillStatementCoverage();
    expect(first.updated).toBeGreaterThanOrEqual(1);
    const covered = await db.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(covered.statementCoveredFrom?.toISOString()).toBe(early.toISOString());
    expect(covered.statementCoveredTo?.toISOString()).toBe(late.toISOString());
    expect(await db.reconFlag.count({ where: { userId: user.id } })).toBe(0);

    const again = await backfillStatementCoverage();
    expect(again.updated).toBe(0);
  });

  it("links one SMS to the one unclaimed statement row, and leaves two statement rows alone", async () => {
    const user = await db.user.create({ data: { email: "link-sms@test.dev" } });
    const account = await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTBank ••4321", maskedAccountNumber: "****4321", currency: "NGN" },
    });
    const day = new Date("2026-10-04T17:00:00.000Z");
    const sms = await db.transaction.create({
      data: {
        userId: user.id, accountId: account.id, source: "sms", sourceTransactionId: "link-sms", fingerprint: "link-sms",
        transactionDate: day, type: "DEBIT", amountMinor: 500_000n, currency: "NGN",
        description: "POS ACME MART", category: "Other", classificationSource: "rule", classificationConfidence: 1,
        sources: { create: { userId: user.id, source: "sms", sourceTransactionId: "link-sms", matchType: "created" } },
      },
    });
    const statement = await db.transaction.create({
      data: {
        userId: user.id, accountId: account.id, source: "statement", sourceTransactionId: "link-stmt", fingerprint: "link-stmt",
        transactionDate: new Date("2026-10-04T11:00:00.000Z"), type: "DEBIT", amountMinor: 500_000n, currency: "NGN",
        description: "ATM WITHDRAWAL", category: "Other", classificationSource: "rule", classificationConfidence: 1,
        sources: { create: { userId: user.id, source: "statement", sourceTransactionId: "link-stmt", matchType: "created" } },
      },
    });
    await db.transaction.create({
      data: {
        userId: user.id, accountId: account.id, source: "statement", sourceTransactionId: "link-stmt-2", fingerprint: "link-stmt-2",
        transactionDate: day, type: "DEBIT", amountMinor: 900_000n, currency: "NGN",
        description: "Other amount", category: "Other", classificationSource: "rule", classificationConfidence: 1,
        sources: { create: { userId: user.id, source: "statement", sourceTransactionId: "link-stmt-2", matchType: "created" } },
      },
    });

    expect(await planSmsStatementLinks(user.id)).toEqual([]);
    await backfillStatementCoverage();
    const planned = await planSmsStatementLinks(user.id);
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ smsId: sms.id, statementId: statement.id, type: "DEBIT", amountMinor: 500_000n });
    expect(formatLinkLine(planned[0])).toBe("2026-10-04 DEBIT 500000");
    expect(formatLinkLine(planned[0])).not.toMatch(/ACME|ATM|1234/);

    const preview = await db.transaction.count({ where: { userId: user.id } });
    expect(preview).toBe(3);
    expect(await applySmsStatementLinks(planned)).toBe(1);
    const rows = await db.transaction.findMany({ where: { userId: user.id }, include: { sources: true } });
    expect(rows).toHaveLength(2);
    const merged = rows.find((r) => r.id === sms.id);
    expect(merged?.sources.map((s) => s.source).sort()).toEqual(["sms", "statement"]);
    expect(await planSmsStatementLinks(user.id)).toEqual([]);
    expect(await applySmsStatementLinks(planned)).toBe(0);
  });

  it("does not link an SMS when two statement rows share its amount and day", async () => {
    const user = await db.user.create({ data: { email: "link-sms-ambig@test.dev" } });
    const account = await db.account.create({
      data: { userId: user.id, institution: "GTBank", accountName: "GTBank ••9999", maskedAccountNumber: "****9999", currency: "NGN" },
    });
    const day = new Date("2026-10-04T12:00:00.000Z");
    await db.transaction.create({
      data: {
        userId: user.id, accountId: account.id, source: "sms", sourceTransactionId: "ambig-sms", fingerprint: "ambig-sms",
        transactionDate: day, type: "DEBIT", amountMinor: 500_000n, currency: "NGN",
        description: "POS ACME MART", category: "Other", classificationSource: "rule", classificationConfidence: 1,
        sources: { create: { userId: user.id, source: "sms", sourceTransactionId: "ambig-sms", matchType: "created" } },
      },
    });
    for (const id of ["ambig-a", "ambig-b"]) {
      await db.transaction.create({
        data: {
          userId: user.id, accountId: account.id, source: "statement", sourceTransactionId: id, fingerprint: id,
          transactionDate: day, type: "DEBIT", amountMinor: 500_000n, currency: "NGN",
          description: id, category: "Other", classificationSource: "rule", classificationConfidence: 1,
          sources: { create: { userId: user.id, source: "statement", sourceTransactionId: id, matchType: "created" } },
        },
      });
    }
    await backfillStatementCoverage();
    expect(await planSmsStatementLinks(user.id)).toEqual([]);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(3);
  });
});
