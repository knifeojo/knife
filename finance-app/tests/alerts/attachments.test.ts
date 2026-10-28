import { describe, expect, it } from "vitest";
import { ImapEmailSource, type ImapClientLike } from "@/core/alerts/imap";
import {
  attachmentsFromGmailPayload,
  attachmentsFromInboundRaw,
  attachmentsFromMime,
  emailFieldsFromGmailResource,
  isStatementAttachment,
} from "@/core/alerts/attachments";
import { adaptInbound, parsePostmarkInbound } from "@/core/alerts/inbound";

const CSV = "Date,Description,Debit,Credit,Balance\n01/09/2026,TRANSFER TO ADA OKAFOR,10.00,,90.00\n";

function mockClient(source: Buffer): ImapClientLike {
  return {
    connect: async () => {},
    logout: async () => {},
    mailboxOpen: async () => ({}),
    search: async () => [],
    fetchOne: async () => ({ source, uid: 4 }),
  };
}

describe("statement attachment types", () => {
  it("keeps pdf, csv and xlsx and drops images and old xls", () => {
    expect(isStatementAttachment("e-statement.pdf", "application/octet-stream")).toBe(true);
    expect(isStatementAttachment("export.csv", "text/plain")).toBe(true);
    expect(isStatementAttachment("book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true);
    expect(isStatementAttachment("scan.jpg", "image/jpeg")).toBe(false);
    expect(isStatementAttachment("legacy.xls", "application/vnd.ms-excel")).toBe(false);
    expect(isStatementAttachment("", "text/plain")).toBe(false);
  });
});

describe("Gmail attachment extraction", () => {
  it("reads an inline CSV and remembers a PDF attachment id", () => {
    const csv = Buffer.from(CSV).toString("base64url");
    const payload = {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Statements <statements@gtbank.com>" },
        { name: "Subject", value: "Your e-statement" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("Your statement is attached.").toString("base64url") } },
        { mimeType: "image/png", filename: "logo.png", body: { data: Buffer.from("png").toString("base64url") } },
        { mimeType: "text/csv", filename: "statement.csv", body: { data: csv, size: CSV.length } },
        { mimeType: "application/pdf", filename: "september.pdf", body: { attachmentId: "att-pdf", size: 999 } },
      ],
    };
    const email = emailFieldsFromGmailResource({ id: "m1", internalDate: "1756684800000", payload });
    expect(email.from).toContain("gtbank.com");
    expect(email.subject).toBe("Your e-statement");
    expect(email.text).toContain("attached");
    expect(email.attachments.map((item) => item.filename)).toEqual(["statement.csv", "september.pdf"]);
    expect(email.attachments[0].bytes?.toString("utf8")).toBe(CSV);
    expect(email.attachments[1].attachmentId).toBe("att-pdf");
    expect(email.attachments[1].bytes).toBeUndefined();
    expect(attachmentsFromGmailPayload(payload)).toHaveLength(2);
  });
});

describe("IMAP attachment extraction", () => {
  it("reads a CSV part from a multipart message", async () => {
    const boundary = "bound123";
    const raw = Buffer.from(
      [
        "From: Statements <statements@gtbank.com>",
        "Subject: Your e-statement",
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        "Content-Type: text/plain",
        "",
        "Please find your statement.",
        `--${boundary}`,
        'Content-Type: text/csv; name="statement.csv"',
        'Content-Disposition: attachment; filename="statement.csv"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(CSV).toString("base64"),
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
    const src = new ImapEmailSource({ host: "imap.mail.yahoo.com", port: 993, user: "ada@yahoo.com", password: "app-password-never-logged" }, () => mockClient(raw));
    const msg = await src.getMessage("4");
    expect(msg.subject).toMatch(/e-statement/i);
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments?.[0].filename).toBe("statement.csv");
    expect(msg.attachments?.[0].bytes?.toString("utf8")).toBe(CSV);
  });
});

describe("forwarding inbox attachment extraction", () => {
  it("reads Postmark, generic JSON and Cloudflare raw MIME", async () => {
    const b64 = Buffer.from(CSV).toString("base64");
    const postmark = parsePostmarkInbound({
      To: "alerts-tok@x.test",
      From: "statements@firstbanknigeria.com",
      Subject: "Account statement",
      TextBody: "Attached",
      MessageID: "pm-1",
      Attachments: [{ Name: "statement.csv", ContentType: "text/csv", Content: b64 }],
    });
    expect(postmark?.attachments?.[0].bytes?.toString("utf8")).toBe(CSV);

    const generic = adaptInbound({
      to: "alerts-tok@x.test",
      from: "statements@sterling.ng",
      subject: "e-statement",
      text: "Attached",
      attachments: [{ filename: "e-statement.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: b64 }],
    });
    expect(generic?.attachments?.[0].filename).toBe("e-statement.xlsx");
    expect(generic?.attachments?.[0].bytes?.toString("utf8")).toBe(CSV);

    const boundary = "cfbound";
    const mime = [
      "From: statements@providusbank.com",
      "Subject: Account statement",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      "Statement attached.",
      `--${boundary}`,
      'Content-Type: text/csv; name="account-statement.csv"',
      'Content-Disposition: attachment; filename="account-statement.csv"',
      "Content-Transfer-Encoding: base64",
      "",
      b64,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const fromRaw = await attachmentsFromInboundRaw({ raw: mime });
    expect(fromRaw).toHaveLength(1);
    expect(fromRaw[0].filename).toBe("account-statement.csv");
    expect(fromRaw[0].bytes?.toString("utf8")).toBe(CSV);

    const fromMime = await attachmentsFromMime(mime);
    expect(fromMime[0].bytes?.toString("utf8")).toBe(CSV);
  });
});
