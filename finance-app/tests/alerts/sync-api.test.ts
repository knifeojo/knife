import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { issueSession } from "@/lib/auth";
import { POST as sync } from "@/app/api/v1/alerts/sync/route";
import { resetRateLimits } from "@/lib/rate-limit";

function post(token?: string) {
  return new Request("http://localhost/api/v1/alerts/sync", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: "{}",
  });
}

describe("POST /api/v1/alerts/sync", () => {
  let token: string;
  let userId: string;

  beforeAll(async () => {
    resetRateLimits();
    const user = await db.user.create({ data: { email: "sync-api@test.dev" } });
    userId = user.id;
    token = (await issueSession(user.id)).token;
  });

  it("requires a session", async () => {
    const res = await sync(post());
    expect(res.status).toBe(401);
  });

  it("returns a summary instead of 404 when the user has no mailbox", async () => {
    const res = await sync(post(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toBe("No email connection to sync.");
    expect(body.results).toEqual([]);
    expect(body.emailsScanned).toBe(0);
    expect(body.created).toBe(0);
    expect(body.duplicates).toBe(0);
  });

  it("syncs a Gmail connection and reports the failure in the summary", async () => {
    await db.financialConnection.create({
      data: { userId, provider: "gmail", providerAccountId: "ada@ledger.test", status: "active" },
    });
    const res = await sync(post(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ provider: "gmail", ok: false });
    expect(String(body.results[0].error)).toMatch(/refresh token|reconnect/i);
    expect(body.message).toBe("Email sync finished with an error.");
  });
});
