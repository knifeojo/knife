import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { credentials, loginCredentials } from "@/lib/credentials";
import { hashPassword, issueSession, verifyPassword } from "@/lib/auth";
import { log } from "@/lib/log";
import { LOGIN_LIMIT, SIGNUP_LIMIT, rateLimit } from "@/lib/rate-limit";
import { apiError, apiJson, clientIp, publicUser, readJsonObject } from "./http";

const INVALID = "Invalid email or password";

// One throwaway hash so a missing user takes about as long as a wrong password.
let dummyHash: Promise<string> | undefined;
function dummyPasswordHash() {
  dummyHash ??= hashPassword("ledger-mobile-timing-pad");
  return dummyHash;
}

function emailKey(body: Record<string, unknown>) {
  return typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "invalid";
}

export async function signupWithPassword(req: Request): Promise<NextResponse> {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const ip = clientIp(req);
  const limited = rateLimit(`signup:${ip}`, SIGNUP_LIMIT.limit, SIGNUP_LIMIT.windowMs);
  if (!limited.allowed) return apiError(429, "Too many attempts. Try again later.", { "Retry-After": String(limited.retryAfterSec) });

  const name = typeof body.name === "string" && body.name.trim() === "" ? undefined : body.name;
  const credentialsResult = credentials.safeParse({ email: body.email, password: body.password, name });
  if (!credentialsResult.success) return apiError(400, credentialsResult.error.issues[0]?.message ?? "Invalid input");

  const { email, password, name: displayName } = credentialsResult.data;
  if (await db.user.findUnique({ where: { email } })) {
    return apiError(409, "An account with this email already exists. Log in instead.");
  }

  let user;
  try {
    user = await db.user.create({ data: { email, name: displayName, passwordHash: await hashPassword(password) } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return apiError(409, "An account with this email already exists. Log in instead.");
    }
    throw e;
  }
  const session = await issueSession(user.id);
  log.info("auth.signup", { userId: user.id, via: "mobile" });
  return apiJson({ token: session.token, expiresAt: session.expiresAt.toISOString(), user: publicUser(user) }, 201);
}

export async function loginWithPassword(req: Request): Promise<NextResponse> {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const ip = clientIp(req);
  const limited = rateLimit(`login:${ip}:${emailKey(body)}`, LOGIN_LIMIT.limit, LOGIN_LIMIT.windowMs);
  if (!limited.allowed) return apiError(429, "Too many attempts. Try again later.", { "Retry-After": String(limited.retryAfterSec) });

  const credentialsResult = loginCredentials.safeParse({ email: body.email, password: body.password });
  if (!credentialsResult.success) {
    await verifyPassword("invalid", await dummyPasswordHash());
    log.warn("auth.login_failed", { ip });
    return apiError(401, INVALID);
  }

  const user = await db.user.findUnique({ where: { email: credentialsResult.data.email } });
  if (!user?.passwordHash || !(await verifyPassword(credentialsResult.data.password, user.passwordHash))) {
    if (!user?.passwordHash) await verifyPassword(credentialsResult.data.password, await dummyPasswordHash());
    log.warn("auth.login_failed", { ip });
    return apiError(401, INVALID);
  }

  const session = await issueSession(user.id);
  log.info("auth.login", { userId: user.id, via: "mobile" });
  return apiJson({ token: session.token, expiresAt: session.expiresAt.toISOString(), user: publicUser(user) });
}
