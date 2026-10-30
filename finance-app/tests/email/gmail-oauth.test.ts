import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { issueSession } from "@/lib/auth";
import { activeConnectionFor, disconnectGmailInbox, listEmailConnections, saveGmailInbox, saveImapInbox, startGmailConnect } from "@/core/email/inboxes";
import { GET as callback, gmailCallbackPage, returnToLedgerLink } from "@/app/api/v1/email/google/callback/route";
import { POST as start } from "@/app/api/v1/email/google/start/route";
import { GMAIL_READONLY_SCOPE, authorizationUrl } from "@/core/providers/gmail";

const CLIENT = "test-client.apps.googleusercontent.com";
const BASE = "https://ledger.example.ts.net";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.GOOGLE_CLIENT_ID = CLIENT;
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.PUBLIC_BASE_URL = BASE;
});

describe("Gmail OAuth for any inbox", () => {
  it("builds Sign in with Google from PUBLIC_BASE_URL and the env client id", async () => {
    const user = await db.user.create({ data: { email: "oauth-start@test.dev" } });
    const { url } = await startGmailConnect(user.id);
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://accounts.google.com");
    expect(parsed.searchParams.get("client_id")).toBe(CLIENT);
    expect(parsed.searchParams.get("redirect_uri")).toBe(`${BASE}/api/v1/email/google/callback`);
    expect(parsed.searchParams.get("scope")).toBe(GMAIL_READONLY_SCOPE);
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("select_account consent");
    expect(parsed.searchParams.get("login_hint")).toBeNull();
    const web = new URL(authorizationUrl("state-1"));
    expect(web.searchParams.get("prompt")).toBe("select_account consent");
    expect(web.searchParams.has("login_hint")).toBe(false);
    expect(parsed.searchParams.get("response_type")).toBe("code");

    const missing = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    await expect(startGmailConnect(user.id)).rejects.toThrow(/not configured/);
    expect(await db.emailOAuthState.count({ where: { userId: user.id } })).toBe(1);
    process.env.PUBLIC_BASE_URL = missing;
  });

  it("stays inert when Google credentials or PUBLIC_BASE_URL are unset", async () => {
    const user = await db.user.create({ data: { email: "oauth-unset@test.dev" } });
    const token = (await issueSession(user.id)).token;
    const saved = {
      id: process.env.GOOGLE_CLIENT_ID,
      secret: process.env.GOOGLE_CLIENT_SECRET,
      base: process.env.PUBLIC_BASE_URL,
    };
    const restore = () => {
      if (saved.id === undefined) delete process.env.GOOGLE_CLIENT_ID;
      else process.env.GOOGLE_CLIENT_ID = saved.id;
      if (saved.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
      else process.env.GOOGLE_CLIENT_SECRET = saved.secret;
      if (saved.base === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = saved.base;
    };
    const post = () =>
      start(
        new Request("http://localhost/api/v1/email/google/start", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: "{}",
        }),
      );
    try {
      for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "PUBLIC_BASE_URL"] as const) {
        restore();
        delete process.env[key];
        const before = await db.emailOAuthState.count({ where: { userId: user.id } });
        const res = await post();
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.error).toMatch(/not configured/i);
        expect(JSON.stringify(body)).not.toContain("accounts.google.com");
        expect(await db.emailOAuthState.count({ where: { userId: user.id } })).toBe(before);
      }
    } finally {
      restore();
    }
  });

  it("stores an encrypted refresh token per inbox and lists Gmail next to Yahoo", async () => {
    const user = await db.user.create({ data: { email: "oauth-inboxes@test.dev" } });
    const first = await saveGmailInbox(user.id, {
      address: "Ada@Example.test",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresIn: 3600,
      scope: GMAIL_READONLY_SCOPE,
      historyId: "h1",
    });
    const second = await saveGmailInbox(user.id, {
      address: "second@example.test",
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresIn: 3600,
      scope: GMAIL_READONLY_SCOPE,
      historyId: "h2",
    });
    await saveImapInbox(user.id, { host: "imap.mail.yahoo.com", port: 993, user: "ada@yahoo.test" });

    const rows = await db.emailConnection.findMany({ where: { userId: user.id }, orderBy: { address: "asc" } });
    expect(rows.map((row) => row.address)).toEqual(["ada@example.test", "ada@yahoo.test", "second@example.test"]);
    expect(rows.every((row) => row.encryptedRefreshToken == null || !row.encryptedRefreshToken.includes("refresh-"))).toBe(true);
    const gmail = rows.find((row) => row.address === "ada@example.test");
    expect(gmail?.encryptedRefreshToken).toBeTruthy();
    expect(decrypt(gmail!.encryptedRefreshToken!)).toBe("refresh-1");
    expect(first.financialConnectionId).not.toBe(second.financialConnectionId);

    const listed = await listEmailConnections(user.id);
    expect(listed.map((row) => row.provider).sort()).toEqual(["gmail", "gmail", "imap"]);

    const due = await db.financialConnection.findMany({
      where: { userId: user.id, status: "active", provider: { in: ["gmail", "imap"] } },
    });
    expect(due).toHaveLength(3);

    const picked = await activeConnectionFor(user.id, { connectionId: second.financialConnectionId });
    expect(picked?.providerAccountId).toBe("second@example.test");
    expect(picked?.id).not.toBe(first.financialConnectionId);
    expect(await disconnectGmailInbox(user.id, second.financialConnectionId)).toBe(true);
    expect(await activeConnectionFor(user.id, { connectionId: first.financialConnectionId })).toMatchObject({ providerAccountId: "ada@example.test" });
    const left = await listEmailConnections(user.id);
    expect(left.map((row) => row.address).sort()).toEqual(["ada@example.test", "ada@yahoo.test"]);
    const revoked = await db.financialConnection.findUniqueOrThrow({ where: { id: second.financialConnectionId } });
    expect(revoked.status).toBe("revoked");
    expect(revoked.encryptedRefreshToken).toBeNull();
  });

  it("the phone start route returns that URL and a bad callback does not store a token", async () => {
    const user = await db.user.create({ data: { email: "oauth-route@test.dev" } });
    const token = (await issueSession(user.id)).token;
    const res = await start(new Request("http://localhost/api/v1/email/google/start", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(new URL(body.url).searchParams.get("redirect_uri")).toBe(`${BASE}/api/v1/email/google/callback`);
    expect(body.url).toContain(`client_id=${encodeURIComponent(CLIENT)}`);

    const bad = await callback(new Request("http://localhost/api/v1/email/google/callback"));
    expect(bad.status).toBe(400);
    const html = await bad.text();
    expect(html).toContain("Gmail was not connected");
    expect(html).toContain("Return to Ledger");
    expect(html).toContain("ledger://email-connected?error=incomplete");
    expect(await db.emailConnection.count({ where: { userId: user.id } })).toBe(0);

    const linked = returnToLedgerLink({ address: "ada@example.test" });
    expect(linked).toBe("ledger://email-connected?address=ada%40example.test");
    const ok = await gmailCallbackPage(200, "Gmail connected", "ada@example.test is connected.", linked).text();
    expect(ok).toContain("Return to Ledger");
    expect(ok).toContain("ledger://email-connected?address=ada%40example.test");
    expect(ok).toContain("location.replace");
  });
});
