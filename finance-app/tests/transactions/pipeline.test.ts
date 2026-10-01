import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestTransaction, syncEmailSource } from "@/core/ledger";
import { FixtureEmailSource } from "@/core/providers/fixture";
import { GTBANK_FIXTURES as F } from "@/core/fixtures/gtbank-alerts";
import { listTransactions, recategorize, NotFoundError } from "@/core/analytics";

async function makeUser(email: string) {
  const user = await db.user.create({ data: { email } });
  const conn = await db.financialConnection.create({ data: { userId: user.id, provider: "fixture" } });
  return { user, conn };
}

describe("email ingestion pipeline", () => {
  let userId: string;
  let connId: string;

  beforeAll(async () => {
    const { user, conn } = await makeUser("pipeline@test.dev");
    userId = user.id;
    connId = conn.id;
  });

  it("parses, dedups resent alerts, and skips non-transaction email", async () => {
    // Sync with a far-past watermark so all fixtures are in range
    await db.financialConnection.update({ where: { id: connId }, data: { lastSyncedAt: new Date("2026-01-01") } });
    const r = await syncEmailSource(userId, connId, new FixtureEmailSource());
    expect(r.emailsScanned).toBe(13);
    expect(r.parsed).toBe(10);
    expect(r.created).toBe(9); // fx-010 is a resend of fx-001
    expect(r.duplicates).toBe(1);
    expect(r.parseFailures).toBeGreaterThanOrEqual(1); // malformed alert
    expect(r.skipped + r.parseFailures).toBe(3); // malformed, marketing, other bank

    const count = await db.transaction.count({ where: { userId } });
    expect(count).toBe(9);
  });

  it("is idempotent: a second sync creates nothing and re-reads nothing", async () => {
    const r = await syncEmailSource(userId, connId, new FixtureEmailSource());
    expect(r.emailsScanned).toBe(0);
    expect(r.created).toBe(0);
    expect(await db.transaction.count({ where: { userId } })).toBe(9);
  });

  it("stores email metadata only, never bodies", async () => {
    const rows = await db.processedEmail.findMany({ where: { userId } });
    expect(rows.length).toBe(13);
    for (const r of rows) expect(Object.keys(r)).not.toContain("html");
    expect(JSON.stringify(rows)).not.toContain("Available Balance");
  });

  it("records sync metrics", async () => {
    const runs = await db.syncRun.findMany({ where: { userId }, orderBy: { startedAt: "asc" } });
    expect(runs[0]).toMatchObject({ status: "success", created: 9, duplicates: 1 });
    expect(runs[0].avgConfidence).toBeGreaterThan(0.5);
  });

  it("updates the account balance from the latest alert and masks the account number", async () => {
    const acct = await db.account.findFirstOrThrow({ where: { userId, currency: "NGN" } });
    expect(acct.maskedAccountNumber).toBe("****4521");
    // Alerts without an account number attach to the only known NGN account
    expect(await db.account.count({ where: { userId, currency: "NGN" } })).toBe(1);
    // latest NGN alert with a balance is the SMS fee late on 25 Sep
    expect(acct.balanceMinor).toBe(449_997_600n);
  });

  it("merges the same transaction arriving from statement and open banking into one ledger row", async () => {
    const base = F.gensDebitTransfer;
    const before = await db.transaction.count({ where: { userId } });
    const stmt = await ingestTransaction(userId, {
      institution: "GTBank", source: "statement", sourceTransactionId: "stmt-2026-09-row-14",
      type: "DEBIT", amountMinor: 25_000_000n, currency: "NGN",
      transactionDate: new Date("2026-09-25T00:00:00Z"), description: "TRF OLUWASEUN ADEYEMI RENT", reference: "000013260925101452001",
      accountLast4: "4521", confidence: 1,
    });
    const mono = await ingestTransaction(userId, {
      institution: "GTBank", source: "mono", sourceTransactionId: "mono-abc",
      type: "DEBIT", amountMinor: 25_000_000n, currency: "NGN",
      transactionDate: new Date("2026-09-25T10:00:00Z"), description: "TRF/RENT SEPT OLUWASEUN ADEYEMI",
      accountLast4: "4521", confidence: 1,
    });
    expect(stmt.status).toBe("duplicate");
    expect(mono.status).toBe("duplicate");
    expect(await db.transaction.count({ where: { userId } })).toBe(before);
    const tx = await db.transaction.findFirstOrThrow({ where: { userId, reference: "000013260925101452001" }, include: { sources: true } });
    expect(tx.sources.map((s) => s.source).sort()).toEqual(["fixture", "fixture", "mono", "statement"].sort());
    expect(base.id).toBe("fx-001");
  });
});

describe("authorization: user scoping", () => {
  it("user A cannot list or modify user B's transactions", async () => {
    const a = await makeUser("a@test.dev");
    const b = await makeUser("b@test.dev");
    await ingestTransaction(b.user.id, {
      institution: "GTBank", source: "fixture", sourceTransactionId: "b-1", type: "DEBIT", amountMinor: 100_000n,
      currency: "NGN", transactionDate: new Date(), description: "UBER TRIP", confidence: 1,
    });
    const bTx = await db.transaction.findFirstOrThrow({ where: { userId: b.user.id } });

    const aList = await listTransactions(a.user.id, {});
    expect(aList.total).toBe(0);
    const aSearch = await listTransactions(a.user.id, { q: "UBER" });
    expect(aSearch.rows.find((r) => r.id === bTx.id)).toBeUndefined();

    await expect(recategorize(a.user.id, bTx.id, "Food", null)).rejects.toBeInstanceOf(NotFoundError);
    const unchanged = await db.transaction.findUniqueOrThrow({ where: { id: bTx.id } });
    expect(unchanged.category).toBe("Transport");
  });

  it("identical alerts for two different users create two separate rows", async () => {
    const a = await makeUser("c@test.dev");
    const b = await makeUser("d@test.dev");
    const tx = { institution: "GTBank", source: "fixture" as const, sourceTransactionId: "same-msg", type: "DEBIT" as const, amountMinor: 5n, currency: "NGN", transactionDate: new Date(), description: "X", reference: "REF12345", confidence: 1 };
    expect((await ingestTransaction(a.user.id, tx)).status).toBe("created");
    expect((await ingestTransaction(b.user.id, tx)).status).toBe("created");
  });
});

describe("user corrections teach future ingestion", () => {
  it("applies a learned category to new transactions from the same counterparty", async () => {
    const { user } = await makeUser("learn@test.dev");
    const first = await ingestTransaction(user.id, {
      institution: "GTBank", source: "fixture", sourceTransactionId: "l-1", type: "DEBIT", amountMinor: 1_000_000n,
      currency: "NGN", transactionDate: new Date("2026-08-01T10:00:00Z"), description: "NIP/MAMA NKECHI/UPKEEP", reference: "L0000001", confidence: 1,
    });
    await recategorize(user.id, first.transactionId, "Family", "Parents");
    const second = await ingestTransaction(user.id, {
      institution: "GTBank", source: "fixture", sourceTransactionId: "l-2", type: "DEBIT", amountMinor: 1_000_000n,
      currency: "NGN", transactionDate: new Date("2026-09-01T10:00:00Z"), description: "NIP/MAMA NKECHI/UPKEEP SEPT", reference: "L0000002", confidence: 1,
    });
    const t2 = await db.transaction.findUniqueOrThrow({ where: { id: second.transactionId } });
    expect(t2).toMatchObject({ category: "Family", subcategory: "Parents", classificationSource: "user" });
  });
});
