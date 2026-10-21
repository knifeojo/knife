import "server-only";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "./db";
import { randomToken, sha256 } from "./crypto";

// Server-side sessions: the cookie (web) or Authorization header (mobile) holds a random token.
// The database stores only its SHA-256.

export const SESSION_COOKIE = "fa_session";
const SESSION_DAYS = 30;

export type SessionUser = { id: string; email: string; name: string | null; isDemo: boolean };

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 12);
}

export async function verifyPassword(pw: string, hash: string) {
  return bcrypt.compare(pw, hash);
}

export async function issueSession(userId: string) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.session.create({ data: { userId, tokenHash: sha256(token), expiresAt } });
  return { token, expiresAt };
}

export async function revokeSessionToken(token: string) {
  await db.session.deleteMany({ where: { tokenHash: sha256(token) } });
}

export async function sessionFromToken(token: string | null | undefined): Promise<{ user: SessionUser; expiresAt: Date } | null> {
  if (!token) return null;
  const session = await db.session.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!session || session.expiresAt < new Date()) return null;
  const { id, email, name, isDemo } = session.user;
  return { user: { id, email, name, isDemo }, expiresAt: session.expiresAt };
}

export async function createSession(userId: string) {
  const { token, expiresAt } = await issueSession(userId);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await revokeSessionToken(token);
  store.delete(SESSION_COOKIE);
}

/** The only way the web app learns who the caller is. Never accept a userId from the client. */
export const getCurrentUser = cache(async () => {
  const store = await cookies();
  const session = await sessionFromToken(store.get(SESSION_COOKIE)?.value);
  return session?.user ?? null;
});

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
