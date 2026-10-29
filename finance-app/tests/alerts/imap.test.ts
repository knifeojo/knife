import { describe, expect, it, vi } from "vitest";
import {
  ImapEmailSource,
  attachmentNamesFromStructure,
  bankEmailFromQuery,
  decodeImapMessageId,
  encodeImapMessageId,
  formatStatementCandidateLine,
  imapClientOptions,
  imapFromClauses,
  imapMessageIdAliases,
  imapReconnectDelayMs,
  isImapDisconnectError,
  isRelevantImapFolder,
  relevantImapFolders,
  type ImapClientLike,
  IMAP_BATCH_SIZE,
  IMAP_CONNECTION_TIMEOUT_MS,
  IMAP_SOCKET_TIMEOUT_MS,
} from "@/core/alerts/imap";
import { log } from "@/lib/log";

function rfc822(opts?: { subject?: string; amount?: string; account?: string; desc?: string }) {
  const amount = opts?.amount ?? "NGN1,000.00";
  const account = opts?.account ?? "******2468";
  const desc = opts?.desc ?? "NIP TRANSFER TO ADA OKAFOR";
  return Buffer.from(
    [
      "From: GeNS <gens@gtbank.com>",
      `Subject: ${opts?.subject ?? `GeNS Transaction Alert [Debit: ${amount}]`}`,
      "Date: Fri, 2 Oct 2026 12:20:00 +0100",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Guaranty Trust Bank Electronic Notification Service (GeNS)",
      "We wish to inform you that a Debit transaction occurred on your account with us.",
      `Account Number: ${account}`,
      `Amount: ${amount}`,
      `Description: ${desc}`,
      "Value Date: 02-Oct-2026",
      "",
    ].join("\r\n"),
  );
}

function statementRfc822() {
  const boundary = "stmtbound";
  return Buffer.from(
    [
      "From: Statements <statements@gtbank.com>",
      "Subject: Your e-statement",
      "Date: Thu, 1 Oct 2026 09:00:00 +0100",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      "Please find your statement.",
      `--${boundary}`,
      'Content-Type: application/pdf; name="e-statement.pdf"',
      'Content-Disposition: attachment; filename="e-statement.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("%PDF-synthetic").toString("base64"),
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  );
}

function mockClient(overrides: Partial<ImapClientLike> = {}): ImapClientLike {
  return {
    connect: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    mailboxOpen: vi.fn().mockResolvedValue({ uidValidity: 9, path: "INBOX" }),
    search: vi.fn().mockResolvedValue([10, 17, 18]),
    fetchOne: vi.fn().mockResolvedValue({
      source: rfc822(),
      uid: 17,
      envelope: { from: [{ address: "gens@gtbank.com" }], subject: "GeNS Debit", date: new Date("2026-10-07T14:17:00Z") },
    }),
    ...overrides,
  };
}

describe("IMAP helpers", () => {
  it("keeps INBOX, Archive and All Mail and drops Sent/Trash/Junk", () => {
    expect(
      relevantImapFolders([
        { path: "INBOX", specialUse: "\\Inbox" },
        { path: "Archive", specialUse: "\\Archive" },
        { path: "[Gmail]/All Mail", specialUse: "\\All" },
        { path: "Sent", specialUse: "\\Sent" },
        { path: "Trash", specialUse: "\\Trash" },
        { path: "Bulk", name: "Bulk" },
        { path: "Drafts", specialUse: "\\Drafts" },
      ]),
    ).toEqual(["INBOX", "Archive", "[Gmail]/All Mail"]);
    expect(isRelevantImapFolder({ path: "INBOX" })).toBe(true);
    expect(isRelevantImapFolder({ path: "Archive" })).toBe(true);
  });

  it("encodes folder UIDs and keeps a bare INBOX uid as an alias", () => {
    expect(encodeImapMessageId("INBOX", 17)).toBe("INBOX:17");
    expect(decodeImapMessageId("INBOX:17")).toEqual({ folder: "INBOX", uid: 17 });
    expect(decodeImapMessageId("17")).toEqual({ folder: "INBOX", uid: 17 });
    expect(imapMessageIdAliases("INBOX:17")).toEqual(expect.arrayContaining(["INBOX:17", "17"]));
    expect(encodeImapMessageId("Archive", 4)).toBe("Archive:4");
    expect(decodeImapMessageId("Archive:4")).toEqual({ folder: "Archive", uid: 4 });
  });

  it("treats Yahoo socket drop messages as reconnectable and backs off", () => {
    expect(isImapDisconnectError(new Error("connection not available"))).toBe(true);
    expect(isImapDisconnectError(new Error("Socket timeout"))).toBe(true);
    expect(isImapDisconnectError({ code: "ETIMEDOUT", message: "tick" })).toBe(true);
    expect(isImapDisconnectError(new Error("IMAP message 9 not found"))).toBe(false);
    expect(imapReconnectDelayMs(0)).toBe(1000);
    expect(imapReconnectDelayMs(8)).toBe(30_000);
    expect(IMAP_BATCH_SIZE).toBe(25);
    expect(IMAP_SOCKET_TIMEOUT_MS).toBe(90_000);
    expect(IMAP_CONNECTION_TIMEOUT_MS).toBe(20_000);
  });

  it("sets Yahoo timeouts on the client options", () => {
    const opts = imapClientOptions({ host: "imap.mail.yahoo.com", port: 993, user: "me@yahoo.com", password: "app-password-never-logged" });
    expect(opts).toMatchObject({
      host: "imap.mail.yahoo.com",
      port: 993,
      secure: true,
      socketTimeout: IMAP_SOCKET_TIMEOUT_MS,
      greetingTimeout: 16_000,
      connectionTimeout: IMAP_CONNECTION_TIMEOUT_MS,
    });
  });

  it("reads attachment names from a bodystructure without the message body", () => {
    expect(
      attachmentNamesFromStructure({
        type: "multipart",
        childNodes: [
          { type: "text" },
          { dispositionParameters: { filename: "e-statement.pdf" }, parameters: { name: "e-statement.pdf" } },
        ],
      }),
    ).toEqual(["e-statement.pdf"]);
  });
});

describe("IMAP source (mocked)", () => {
  it("searches UID-mode across INBOX and Archive, oldest first, with a folder prefix", async () => {
    const opened: string[] = [];
    const client = mockClient({
      list: vi.fn().mockResolvedValue([
        { path: "INBOX", specialUse: "\\Inbox" },
        { path: "Archive", specialUse: "\\Archive" },
        { path: "Sent", specialUse: "\\Sent" },
      ]),
      mailboxOpen: vi.fn(async (path: string) => {
        opened.push(path);
        return { uidValidity: 9, path };
      }),
      search: vi.fn(async () => (opened[opened.length - 1] === "Archive" ? [4] : [10, 17, 18])),
    });
    const factory = vi.fn(() => client);
    const after = new Date("2026-10-01");
    const src = new ImapEmailSource({ host: "imap.mail.yahoo.com", port: 993, user: "me@yahoo.com", password: "app-password-never-logged" }, factory);

    const ids = await src.listMessageIds({ query: "", after, max: 10 });
    expect(ids).toEqual(["INBOX:10", "INBOX:17", "INBOX:18", "Archive:4"]);
    expect(opened).toEqual(["INBOX", "Archive"]);
    expect(client.search).toHaveBeenCalledWith({ since: after, or: imapFromClauses() }, { uid: true });
    const banks = bankEmailFromQuery();
    expect(banks).toEqual(expect.arrayContaining([{ from: "gtbank.com" }, { from: "sterling.ng" }, { from: "providusbank.com" }]));
    const froms = imapFromClauses();
    expect(froms).toEqual(expect.arrayContaining([...banks, { from: "deel.com" }, { from: "pesa.com" }]));
  });

  it("resumes after a UID checkpoint so already committed mail is not listed again", async () => {
    const client = mockClient({
      list: vi.fn().mockResolvedValue([{ path: "INBOX", specialUse: "\\Inbox" }]),
      search: vi.fn().mockResolvedValue([10, 17, 18, 22]),
    });
    const src = new ImapEmailSource({ host: "imap.mail.yahoo.com", port: 993, user: "me@yahoo.com", password: "app-password-never-logged" }, () => client);
    const ids = await src.listMessageIds({
      query: "",
      folderCursors: { INBOX: { uid: 17, uidValidity: "9" } },
    });
    expect(ids).toEqual(["INBOX:18", "INBOX:22"]);
  });

  it("resets a folder cursor when UIDVALIDITY changes", async () => {
    const client = mockClient({
      list: vi.fn().mockResolvedValue([{ path: "INBOX", specialUse: "\\Inbox" }]),
      mailboxOpen: vi.fn().mockResolvedValue({ uidValidity: 99, path: "INBOX" }),
      search: vi.fn().mockResolvedValue([10, 17]),
    });
    const src = new ImapEmailSource({ host: "imap.mail.yahoo.com", port: 993, user: "me@yahoo.com", password: "app-password-never-logged" }, () => client);
    const ids = await src.listMessageIds({
      query: "",
      folderCursors: { INBOX: { uid: 17, uidValidity: "9" } },
    });
    expect(ids).toEqual(["INBOX:10", "INBOX:17"]);
    expect(src.folderUidValidity("INBOX")).toBe("99");
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

  it("reconnects after a socket drop and then fetches the message", async () => {
    const failing = mockClient({
      connect: vi.fn().mockRejectedValueOnce(new Error("connection not available")).mockResolvedValueOnce(undefined),
    });
    const factory = vi.fn(() => failing);
    const src = new ImapEmailSource({ host: "imap.mail.yahoo.com", port: 993, user: "me@yahoo.com", password: "app-password-never-logged" }, factory);
    const msg = await src.getMessage("INBOX:17");
    expect(msg.subject).toMatch(/GeNS/);
    expect(failing.connect).toHaveBeenCalledTimes(2);
  });

  it("lists statement candidates from Archive using envelope and filenames, never the body", async () => {
    const fetchOne = vi.fn(async (seq: string | number, query: Record<string, unknown>) => {
      expect(query.source).toBeUndefined();
      expect(query.envelope).toBe(true);
      expect(query.bodyStructure).toBe(true);
      return {
        uid: Number(seq),
        envelope: {
          from: [{ address: "statements@gtbank.com" }],
          subject: "Your e-statement",
          date: new Date("2026-10-01T08:00:00Z"),
        },
        bodyStructure: { childNodes: [{ dispositionParameters: { filename: "e-statement.pdf" } }] },
      };
    });
    const client = mockClient({
      list: vi.fn().mockResolvedValue([
        { path: "INBOX", specialUse: "\\Inbox" },
        { path: "Archive", specialUse: "\\Archive" },
      ]),
      mailboxOpen: vi.fn(async (path: string) => ({ uidValidity: 3, path })),
      search: vi.fn(async () => [4]),
      fetchOne,
    });
    const src = new ImapEmailSource({ host: "imap.mail.yahoo.com", port: 993, user: "ada@yahoo.com", password: "app-password-never-logged" }, () => client);
    const rows = await src.listStatementCandidates({ after: new Date("2025-10-01") });
    expect(rows).toEqual([
      expect.objectContaining({ folder: "INBOX", from: "statements@gtbank.com", filenames: ["e-statement.pdf"] }),
      expect.objectContaining({ folder: "Archive", from: "statements@gtbank.com", filenames: ["e-statement.pdf"] }),
    ]);
    expect(formatStatementCandidateLine(rows[1])).toBe("2026-10-01\tstatements@gtbank.com\tArchive\te-statement.pdf");
    expect(formatStatementCandidateLine(rows[1])).not.toMatch(/Please find|Dear Customer|NGN/);
    expect(statementRfc822().toString()).toContain("e-statement.pdf");
  });
});
