import { NextResponse } from "next/server";
import { randomToken } from "@/lib/crypto";
import { OAUTH_STATE_COOKIE, googleConfigured, signInUrl } from "@/core/providers/gmail";

// "Continue with Google": identity only (openid, email, profile). No mailbox access here.
export async function POST(req: Request) {
  const base = process.env.APP_URL ?? new URL(req.url).origin;
  if (!googleConfigured()) return NextResponse.redirect(new URL("/login?error=google_unconfigured", base), 303);
  const state = randomToken(24);
  const res = NextResponse.redirect(signInUrl(state), 303);
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/auth/google",
    maxAge: 600,
  });
  return res;
}
