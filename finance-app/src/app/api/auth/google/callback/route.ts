import { NextResponse, type NextRequest } from "next/server";
import { createSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { findOrCreateGoogleUser } from "@/lib/google-user";
import { log } from "@/lib/log";
import { OAUTH_STATE_COOKIE, SIGNIN_CALLBACK, exchangeCode, identityFromIdToken } from "@/core/providers/gmail";

export async function GET(req: NextRequest) {
  const base = process.env.APP_URL ?? req.nextUrl.origin;
  const fail = (reason: string) => {
    const res = NextResponse.redirect(new URL(`/login?error=${reason}`, base));
    res.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/auth/google" });
    return res;
  };

  const params = req.nextUrl.searchParams;
  const expected = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!expected || params.get("state") !== expected) return fail("google_state");
  if (params.get("error")) return fail("google_denied");
  const code = params.get("code");
  if (!code) return fail("google_failed");

  try {
    const tokens = await exchangeCode(code, SIGNIN_CALLBACK);
    const identity = identityFromIdToken(tokens.id_token);
    const { id, created } = await findOrCreateGoogleUser(identity);
    await createSession(id);
    log.info("auth.google_signin", { userId: id, created });

    // New users (or anyone without Gmail yet) go straight to the Gmail consent screen.
    const hasGmail = await db.financialConnection.findFirst({ where: { userId: id, provider: "gmail", status: "active" } });
    const res = NextResponse.redirect(new URL(hasGmail ? "/app" : "/app/accounts/connect", base));
    res.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/auth/google" });
    return res;
  } catch (e) {
    log.error("auth.google_failed", { error: e instanceof Error ? e.message : "unknown" });
    return fail("google_failed");
  }
}
