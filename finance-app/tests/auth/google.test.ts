import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { findOrCreateGoogleUser } from "@/lib/google-user";
import { identityFromIdToken } from "@/core/providers/gmail";

const CLIENT = "test-client.apps.googleusercontent.com";
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const good = { aud: CLIENT, iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 600, sub: "g-1", email: "Ada@Example.test", email_verified: true, name: "Ada" };

beforeAll(() => {
  process.env.GOOGLE_CLIENT_ID = CLIENT;
});

describe("Google ID token validation", () => {
  it("accepts a valid token and lowercases email", () => {
    expect(identityFromIdToken(jwt(good))).toEqual({ sub: "g-1", email: "ada@example.test", name: "Ada" });
  });
  it.each([
    ["wrong audience", { aud: "other" }],
    ["wrong issuer", { iss: "https://evil.example" }],
    ["expired", { exp: 1 }],
    ["unverified email", { email_verified: false }],
  ])("rejects %s", (_, override) => {
    expect(() => identityFromIdToken(jwt({ ...good, ...override }))).toThrow();
  });
});

describe("findOrCreateGoogleUser", () => {
  it("creates once, then returns the same user", async () => {
    const a = await findOrCreateGoogleUser({ sub: "g-new", email: "new@example.test" });
    const b = await findOrCreateGoogleUser({ sub: "g-new", email: "new@example.test" });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
  });
  it("links to an existing password account with the same verified email", async () => {
    const u = await db.user.create({ data: { email: "pw@example.test", passwordHash: "x" } });
    const r = await findOrCreateGoogleUser({ sub: "g-pw", email: "pw@example.test" });
    expect(r.id).toBe(u.id);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).googleSub).toBe("g-pw");
  });
});
