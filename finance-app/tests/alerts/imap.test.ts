import { describe, expect, it, vi } from "vitest";
import { ImapEmailSource, bankEmailFromQuery, imapFromClauses, type ImapClientLike } from "@/core/alerts/imap";
import { log } from "@/lib/log";

function rfc822() {
  return Buffer.from(
    `From: GeNS <gens@gtbank.com>\r\nSubject: GeNS Debit\r\nDate: Fri, 3 Oct 2026 16:29:00 +0100\r\n\r\nAmt:NGN1.00 DR\r\n`,
  );
}

function mockClient(overrides: Partial<ImapClientLike> = {}): ImapClientLike {
  return {
    connect: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    mailboxOpen: vi.fn(),
    search: vi.fn().mockResolvedValue([10, 17, 18]),
    fetchOne: vi.fn().mockResolvedValue({
      source: rfc822(),
      uid: 17,
      envelope: { from: [{ address: "gens@gtbank.com" }], subject: "GeNS Debit", date: new Date("2026-10-07T14:17:00Z") },
    }),
    ...overrides,
  };
}

describe("IMAP source (mocked)", () => {
  it("searches UID-mode by bank From (OR) + SINCE and returns newest first", async () => {
    const client = mockClient();
    const factory = vi.fn(() => client);
    const after = new Date("2026-10-01");
    const src = new ImapEmailSource({ host: "imap.mail.yahoo.com", port: 993, user: "me@yahoo.com", password: "app-password-never-logged" }, factory);

    const ids = await src.listMessageIds({ query: "", after, max: 2 });
    expect(ids).toEqual(["18", "17"]);

    const banks = bankEmailFromQuery();
    expect(banks).toEqual(expect.arrayContaining([{ from: "gtbank.com" }, { from: "sterling.ng" }, { from: "providusbank.com" }]));
    const froms = imapFromClauses();
    expect(froms).toEqual(expect.arrayContaining([...banks, { from: "deel.com" }, { from: "pesa.com" }]));
    expect(froms.every((f) => f.from.includes("."))).toBe(true);
    expect(client.search).toHaveBeenCalledWith({ since: after, or: froms }, { uid: true });
  });

  it("fetches one message by UID, not sequence number", async () => {
    const client = mockClient();
    const factory = vi.fn(() => client);
    const src = new ImapEmailSource({ host: "imap.mail.yahoo.com", port: 993, user: "me@yahoo.com", password: "app-password-never-logged" }, factory);

    const msg = await src.getMessage("17");
    expect(client.fetchOne).toHaveBeenCalledWith("17", { source: true, envelope: true }, { uid: true });
    expect(msg.from).toMatch(/gtbank.com/);
    expect(msg.subject).toMatch(/GeNS/);
    expect(msg.attachments ?? []).toEqual([]);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ host: "imap.mail.yahoo.com", user: "me@yahoo.com" }));
    expect(JSON.stringify(log.redact({ password: "app-password-never-logged", host: "imap.mail.yahoo.com" }))).not.toContain("app-password-never-logged");
    expect(client.logout).toHaveBeenCalled();
  });
});
