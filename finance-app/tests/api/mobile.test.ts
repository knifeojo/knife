import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { issueSession, revokeSessionToken, sessionFromToken } from "@/lib/auth";
import { LOGIN_LIMIT, rateLimit, resetRateLimits } from "@/lib/rate-limit";
import { GET as health } from "@/app/api/v1/health/route";
import { POST as signup } from "@/app/api/v1/auth/signup/route";
import { POST as login } from "@/app/api/v1/auth/login/route";
import { POST as logout } from "@/app/api/v1/auth/logout/route";
import { GET as session } from "@/app/api/v1/auth/session/route";
import { GET as accounts } from "@/app/api/v1/accounts/route";
import { GET as transactions } from "@/app/api/v1/transactions/route";
import { GET as summary } from "@/app/api/v1/summary/route";
import { POST as upload } from "@/app/api/v1/statements/route";
import { MAX_STATEMENT_BYTES } from "@/core/statement-import";

const SAMPLE = readFileSync("public/sample-gtbank-statement.csv");

beforeEach(() => resetRateLimits());

let ip = 1;
function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${ip++}`, ...headers },
    body: JSON.stringify(body),
  });
}

function authed(path: string, token: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}`, ...headers } });
}

async function bodyOf(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

async function register(email: string, password = "correct-horse", name?: string) {
  const res = await signup(jsonRequest("/api/v1/auth/signup", { email, password, name }));
  const body = await bodyOf(res);
  return { res, body, token: String(body.token ?? "") };
}

describe("mobile auth", () => {
  it("reports a healthy ledger without leaking configuration", async () => {
    const res = await health();
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body).toEqual({ ok: true, service: "ledger", version: 1 });
    expect(JSON.stringify(body)).not.toMatch(/ENCRYPTION|DATABASE|SECRET/i);
  });

  it("signs up, returns a bearer token, and stores only its hash", async () => {
    const { res, body, token } = await register("ada@ledger.test", "correct-horse", "Ada");
    expect(res.status).toBe(201);
    expect(token.length).toBeGreaterThan(20);
    expect(JSON.stringify(body)).not.toContain("correct-horse");
    expect(body.user).toMatchObject({ email: "ada@ledger.test", name: "Ada", isDemo: false });
    const row = await db.session.findFirst({ where: { user: { email: "ada@ledger.test" } } });
    expect(row?.tokenHash).toBe(sha256(token));
    expect(row?.tokenHash).not.toContain(token);

    const who = await session(authed("/api/v1/auth/session", token));
    expect(who.status).toBe(200);
    expect((await bodyOf(who)).user).toMatchObject({ email: "ada@ledger.test" });
  });

  it("rejects a short password, a duplicate email, and a missing token the same way", async () => {
    expect((await signup(jsonRequest("/api/v1/auth/signup", { email: "short@ledger.test", password: "short" }))).status).toBe(400);
    await register("taken@ledger.test");
    const again = await signup(jsonRequest("/api/v1/auth/signup", { email: "taken@ledger.test", password: "correct-horse" }));
    expect(again.status).toBe(409);

    const missing = await accounts(new Request("http://localhost/api/v1/accounts"));
    expect(missing.status).toBe(401);
    expect(await bodyOf(missing)).toEqual({ error: "Sign in required" });
    const junk = await accounts(authed("/api/v1/accounts", "this-is-not-a-real-session-token"));
    expect(junk.status).toBe(401);
  });

  it("uses one error for an unknown email and a wrong password", async () => {
    await register("known@ledger.test", "correct-horse");
    const unknown = await login(jsonRequest("/api/v1/auth/login", { email: "nobody@ledger.test", password: "correct-horse" }));
    const wrong = await login(jsonRequest("/api/v1/auth/login", { email: "known@ledger.test", password: "wrong-password" }));
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const unknownBody = await bodyOf(unknown);
    const wrongBody = await bodyOf(wrong);
    expect(unknownBody).toEqual(wrongBody);
    expect(wrongBody).toEqual({ error: "Invalid email or password" });
  });

  it("logs in and then logout revokes only that token", async () => {
    const { token } = await register("logout@ledger.test");
    const user = await db.user.findUniqueOrThrow({ where: { email: "logout@ledger.test" } });
    const other = await issueSession(user.id);
    const signedIn = await login(jsonRequest("/api/v1/auth/login", { email: "logout@ledger.test", password: "correct-horse" }));
    expect(signedIn.status).toBe(200);
    const fresh = String((await bodyOf(signedIn)).token);

    const out = await logout(authed("/api/v1/auth/logout", fresh));
    expect(out.status).toBe(200);
    expect((await session(authed("/api/v1/auth/session", fresh))).status).toBe(401);
    expect(await sessionFromToken(token)).not.toBeNull();
    expect(await sessionFromToken(other.token)).not.toBeNull();
    await revokeSessionToken(other.token);
  });

  it("rejects an expired session", async () => {
    const { token } = await register("expired@ledger.test");
    await db.session.updateMany({ where: { tokenHash: sha256(token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await session(authed("/api/v1/auth/session", token))).status).toBe(401);
  });

  it("rate limits repeated login attempts", async () => {
    const email = "limited@ledger.test";
    const ip = "203.0.113.9";
    for (let i = 0; i < LOGIN_LIMIT.limit; i++) rateLimitLogin(ip, email);
    const res = await login(jsonRequest("/api/v1/auth/login", { email, password: "correct-horse" }, { "x-forwarded-for": ip }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

function rateLimitLogin(ip: string, email: string) {
  // Same key as loginWithPassword. Filling it here avoids eight bcrypt rounds.
  rateLimit(`login:${ip}:${email}`, LOGIN_LIMIT.limit, LOGIN_LIMIT.windowMs);
}

describe("mobile ledger reads and statement upload", () => {
  it("imports a sample statement and keeps the other user out of it", async () => {
    const ada = await register("statements@ledger.test");
    const bisi = await register("other-reader@ledger.test");
    const form = new FormData();
    form.set("file", new File([SAMPLE], "sample-gtbank-statement.csv", { type: "text/csv" }));
    form.set("password", "super-secret-pdf-password");
    const imported = await upload(new Request("http://localhost/api/v1/statements", {
      method: "POST",
      headers: { authorization: `Bearer ${ada.token}` },
      body: form,
    }));
    expect(imported.status).toBe(200);
    const importedBody = await bodyOf(imported);
    expect(JSON.stringify(importedBody)).not.toContain("super-secret-pdf-password");
    const results = importedBody.results as { ok?: { created: number; institution: string; accountLast4?: string } }[];
    expect(results[0].ok?.created).toBeGreaterThan(0);
    expect(results[0].ok?.institution).toBe("GTBank");
    expect(results[0].ok?.accountLast4).toBe("4521");

    const adaAccounts = await bodyOf(await accounts(authed("/api/v1/accounts", ada.token)));
    const rows = adaAccounts.accounts as { id: string; institution: string; maskedAccountNumber: string; balanceMinor: string; currency: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ institution: "GTBank", maskedAccountNumber: "****4521", currency: "NGN", balanceMinor: "450000000" });
    expect(adaAccounts.totalBaseMinor).toBe("450000000");

    const listed = await bodyOf(await transactions(authed("/api/v1/transactions?pageSize=50", ada.token)));
    const txs = listed.transactions as { description: string; amountMinor: string; type: string; category: string }[];
    const salary = txs.find((tx) => tx.description.includes("SALARY"));
    expect(salary).toMatchObject({ type: "CREDIT", amountMinor: "198361100", category: "Income" });
    expect(listed.categories).toContain("Income");

    const incomeOnly = await bodyOf(await transactions(authed("/api/v1/transactions?category=Income", ada.token)));
    expect((incomeOnly.transactions as { category: string }[]).every((tx) => tx.category === "Income")).toBe(true);
    expect((await transactions(authed("/api/v1/transactions?category=NotACategory", ada.token))).status).toBe(400);

    const home = await bodyOf(await summary(authed("/api/v1/summary?month=2026-09", ada.token)));
    expect(home.period).toMatchObject({ label: "September 2026" });
    expect(home.incomeMinor).toBe("198361100");
    expect(typeof home.expensesMinor).toBe("string");
    expect(home.balanceMinor).toBe("450000000");
    const spending = home.spendingByCategory as { category: string; totalMinor: string }[];
    expect(spending.length).toBeGreaterThan(0);
    expect(spending.every((row) => typeof row.totalMinor === "string")).toBe(true);

    const bisiAccounts = await bodyOf(await accounts(authed("/api/v1/accounts", bisi.token)));
    expect(bisiAccounts.accounts).toEqual([]);
    expect(bisiAccounts.totalBaseMinor).toBe("0");
    const bisiTx = await bodyOf(await transactions(authed(`/api/v1/transactions?accountId=${rows[0].id}`, bisi.token)));
    expect(bisiTx.transactions).toEqual([]);
    expect(bisiTx.total).toBe(0);
  });

  it("rejects an empty upload and a file over the size limit", async () => {
    const { token } = await register("upload-limits@ledger.test");
    const empty = new FormData();
    const missing = await upload(new Request("http://localhost/api/v1/statements", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: empty }));
    expect(missing.status).toBe(400);

    const huge = new FormData();
    huge.set("file", new File([new Uint8Array(MAX_STATEMENT_BYTES + 1)], "big.csv", { type: "text/csv" }));
    const tooBig = await upload(new Request("http://localhost/api/v1/statements", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: huge }));
    expect(tooBig.status).toBe(200);
    expect(await bodyOf(tooBig)).toEqual({ results: [{ file: "big.csv", error: "File is larger than 5 MB." }] });
  });

  it("rejects a bad month on the summary", async () => {
    const { token } = await register("summary-month@ledger.test");
    expect((await summary(authed("/api/v1/summary?month=2026-13", token))).status).toBe(400);
    expect((await summary(authed("/api/v1/summary?offset=3", token))).status).toBe(400);
  });
});
