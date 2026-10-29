import { describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { ImapEmailSource, type ImapClientLike } from "@/core/alerts/imap";
import { syncEmailSource } from "@/core/ledger";

function alertMime(uid: number, amount: string, desc: string) {
  return Buffer.from(
    [
      "From: GeNS <gens@gtbank.com>",
      `Subject: GeNS Transaction Alert [Debit: ${amount}]`,
      "Date: Fri, 2 Oct 2026 12:20:00 +0100",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Guaranty Trust Bank Electronic Notification Service (GeNS)",
      "We wish to inform you that a Debit transaction occurred on your account with us.",
      "Account Number: ******2468",
      `Amount: ${amount}`,
      `Description: ${desc}`,
      "Value Date: 02-Oct-2026",
      "",
    ].join("\r\n"),
  );
}

const MESSAGES: Record<number, Buffer> = {
  11: alertMime(11, "NGN1,100.00", "SYNTHETIC PAYEE ONE"),
  12: alertMime(12, "NGN1,200.00", "SYNTHETIC PAYEE TWO"),
  13: alertMime(13, "NGN1,300.00", "SYNTHETIC PAYEE THREE"),
  14: alertMime(14, "NGN1,400.00", "SYNTHETIC PAYEE FOUR"),
};

function statefulClient(opts: { failOnUid?: number; failTimes?: number }): { factory: () => ImapClientLike; fetchCount: () => number } {
  let remainingFails = opts.failTimes ?? 0;
  let fetches = 0;
  const factory = (): ImapClientLike => ({
    connect: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([{ path: "INBOX", specialUse: "\\Inbox" }]),
    mailboxOpen: vi.fn().mockResolvedValue({ uidValidity: 5, path: "INBOX" }),
    search: vi.fn().mockResolvedValue([11, 12, 13, 14]),
    fetchOne: vi.fn(async (seq: string | number) => {
      const uid = Number(seq);
      fetches++;
      if (opts.failOnUid === uid && remainingFails > 0) {
        remainingFails--;
        throw new Error("simulated fetch abort");
      }
      return { source: MESSAGES[uid], uid, envelope: { from: [{ address: "gens@gtbank.com" }], subject: "GeNS", date: new Date("2026-10-02T11:20:00Z") } };
    }),
  });
  return { factory, fetchCount: () => fetches };
}

describe("IMAP first-sync catch-up", () => {
  it("pages past the per-listing cap in one run until the UID checkpoint is caught up", async () => {
    const prev = process.env.MAX_MESSAGES_PER_SYNC;
    process.env.MAX_MESSAGES_PER_SYNC = "2";
    try {
      const user = await db.user.create({ data: { email: "imap-catchup@test.dev" } });
      const conn = await db.financialConnection.create({
        data: { userId: user.id, provider: "imap", imapHost: "imap.mail.yahoo.com", imapPort: 993, imapUser: "ada@yahoo.com", status: "active" },
      });
      const client = statefulClient({});
      const summary = await syncEmailSource(
        user.id,
        conn.id,
        new ImapEmailSource({ host: "imap.mail.yahoo.com", port: 993, user: "ada@yahoo.com", password: "app-password-never-logged" }, client.factory),
      );
      expect(summary.created).toBe(4);
      expect(await db.transaction.count({ where: { userId: user.id } })).toBe(4);
      const cursor = await db.imapFolderCursor.findFirst({ where: { connectionId: conn.id, folder: "INBOX" } });
      expect(cursor?.uid).toBe(14);
    } finally {
      if (prev === undefined) delete process.env.MAX_MESSAGES_PER_SYNC;
      else process.env.MAX_MESSAGES_PER_SYNC = prev;
    }
  });
});

describe("IMAP sync resume", () => {
  it("commits each message, checkpoints the UID, and resumes without duplicating after a drop", async () => {
    const user = await db.user.create({ data: { email: "imap-resume@test.dev" } });
    const conn = await db.financialConnection.create({
      data: { userId: user.id, provider: "imap", imapHost: "imap.mail.yahoo.com", imapPort: 993, imapUser: "ada@yahoo.com", status: "active" },
    });
    const first = statefulClient({ failOnUid: 13, failTimes: 1 });
    await expect(
      syncEmailSource(user.id, conn.id, new ImapEmailSource({ host: "imap.mail.yahoo.com", port: 993, user: "ada@yahoo.com", password: "app-password-never-logged" }, first.factory)),
    ).rejects.toThrow(/simulated fetch abort/);

    const cursor = await db.imapFolderCursor.findFirst({ where: { connectionId: conn.id, folder: "INBOX" } });
    expect(cursor?.uid).toBe(12);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(2);
    expect(await db.processedEmail.count({ where: { userId: user.id } })).toBe(2);

    const second = statefulClient({ failOnUid: undefined });
    const summary = await syncEmailSource(
      user.id,
      conn.id,
      new ImapEmailSource({ host: "imap.mail.yahoo.com", port: 993, user: "ada@yahoo.com", password: "app-password-never-logged" }, second.factory),
    );
    expect(summary.created).toBe(2);
    expect(summary.duplicates).toBe(0);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(4);
    expect(await db.processedEmail.count({ where: { userId: user.id } })).toBe(4);
    const again = await syncEmailSource(
      user.id,
      conn.id,
      new ImapEmailSource({ host: "imap.mail.yahoo.com", port: 993, user: "ada@yahoo.com", password: "app-password-never-logged" }, second.factory),
    );
    expect(again.created).toBe(0);
    expect(await db.transaction.count({ where: { userId: user.id } })).toBe(4);
  });
});
