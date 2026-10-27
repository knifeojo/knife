import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { adaptInbound, parseGenericInbound, verifyInboundSecret } from "@/core/alerts/inbound";
import { tokenFromRecipient } from "@/core/alerts/tokens";
import { detectGmailForwardingConfirmation } from "@/core/alerts/confirmation";
import { POST as inbound } from "@/app/api/inbound/email/route";
import { sha256 } from "@/lib/crypto";

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/inbound/email", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("inbound adapters and auth", () => {
  it("reads generic JSON, Cloudflare and Postmark shapes", () => {
    const generic = parseGenericInbound({ to: "alerts-abcTOKEN12@ledger.test", from: "GeNS <gens@gtbank.com>", subject: "Debit", text: "Amt: NGN1.00 DR" });
    expect(generic?.to).toContain("alerts-abcTOKEN12");
    const cf = adaptInbound({ to: "alerts-abcTOKEN12@ledger.test", from: "a@gtbank.com", subject: "Hi", text: "x" });
    expect(cf?.from).toBe("a@gtbank.com");
    const pm = adaptInbound({ To: "alerts-abcTOKEN12@ledger.test", From: "b@gtbank.com", Subject: "S", TextBody: "body", MessageID: "m1" });
    expect(pm?.messageId).toBe("m1");
  });

  it("maps alerts-<token>@domain", () => {
    expect(tokenFromRecipient("Ledger <alerts-tok_ABC-123@example.com>")).toBe("tok_ABC-123");
    expect(tokenFromRecipient("friend@gmail.com")).toBeUndefined();
  });

  it("rejects a missing or wrong shared secret", async () => {
    const prev = process.env.INBOUND_EMAIL_SECRET;
    process.env.INBOUND_EMAIL_SECRET = "correct-secret";
    expect(verifyInboundSecret(req({}), "")).toBe(false);
    expect(verifyInboundSecret(req({}, { "x-inbound-secret": "wrong" }), "")).toBe(false);
    expect(verifyInboundSecret(req({}, { "x-inbound-secret": "correct-secret" }), "")).toBe(true);
    process.env.INBOUND_EMAIL_SECRET = prev;
  });
});

describe("inbound route token mapping", () => {
  let token: string;

  beforeAll(async () => {
    process.env.INBOUND_EMAIL_SECRET = "test-inbound";
    const user = await db.user.create({ data: { email: "inbound@test.dev", inboundEmailToken: "inbTok12345678" } });
    token = user.inboundEmailToken!;
  });

  it("returns 401 without the secret and 404 for an unknown token", async () => {
    expect((await inbound(req({ to: `alerts-${token}@x.test`, from: "a@b.c", subject: "s" }))).status).toBe(401);
    const unknown = await inbound(req({ to: "alerts-notarealtoken1@x.test", from: "GeNS <gens@gtbank.com>", subject: "s", text: "hi" }, { "x-inbound-secret": "test-inbound" }));
    expect(unknown.status).toBe(404);
  });

  it("stores a Gmail forwarding confirmation instead of parsing it", async () => {
    const res = await inbound(
      req(
        {
          to: `alerts-${token}@x.test`,
          from: "forwarding-noreply@google.com",
          subject: "Gmail Forwarding Confirmation - Receive Mail from ada@gmail.com",
          text: "Confirmation code: 482910337\nhttps://mail.google.com/mail/vf-abc123",
        },
        { "x-inbound-secret": "test-inbound" },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.confirmation).toBe(true);
    expect(body.code).toBe("482910337");
    const row = await db.forwardingNotice.findFirst({ where: { user: { email: "inbound@test.dev" } } });
    expect(row?.code).toBe("482910337");
    expect(sha256("x")).toHaveLength(64);
  });
});

describe("confirmation detector", () => {
  it("extracts a code and a mail.google.com link", () => {
    const hit = detectGmailForwardingConfirmation({
      subject: "Gmail Forwarding Confirmation",
      text: "Confirmation code: 123456789 click https://mail.google.com/mail/vf-zz",
    });
    expect(hit).toEqual({ code: "123456789", link: "https://mail.google.com/mail/vf-zz" });
    expect(detectGmailForwardingConfirmation({ subject: "Debit alert", text: "Amt NGN 1" })).toBeNull();
  });
});
