import { describe, expect, it, vi } from "vitest";
import { ImapEmailSource, type ImapClientLike } from "@/core/alerts/imap";

function rfc822() {
  return Buffer.from(
    `From: GeNS <gens@gtbank.com>\r\nSubject: GeNS Debit\r\nDate: Fri, 3 Oct 2026 16:29:00 +0100\r\n\r\nAmt:NGN1.00 DR\r\n`,
  );
}

describe("IMAP source (mocked)", () => {
  it("lists uids since a date and parses RFC822 without logging the password", async () => {
    const search = vi.fn().mockResolvedValue([17, 18]);
    const logout = vi.fn();
    const factory = vi.fn((): ImapClientLike => ({
      connect: vi.fn(),
      logout,
      mailboxOpen: vi.fn(),
      search,
      fetch: async function* () {
        yield { source: rfc822(), uid: 17, envelope: { from: [{ address: "gens@gtbank.com" }], subject: "GeNS Debit", date: new Date("2026-10-03T15:29:00Z") } };
      },
    }));
    const src = new ImapEmailSource({ host: "imap.mail.yahoo.com", port: 993, user: "me@yahoo.com", password: "app-password-never-logged" }, factory);
    const ids = await src.listMessageIds({ query: "", after: new Date("2026-10-01") });
    expect(ids).toEqual(["17", "18"]);
    expect(search).toHaveBeenCalledWith({ since: new Date("2026-10-01") });
    const msg = await src.getMessage("17");
    expect(msg.from).toMatch(/gtbank.com/);
    expect(msg.subject).toMatch(/GeNS/);
    expect(JSON.stringify(factory.mock.calls)).not.toContain("app-password-never-logged");
    expect(logout).toHaveBeenCalled();
  });
});
