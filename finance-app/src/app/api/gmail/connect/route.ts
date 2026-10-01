import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { randomToken } from "@/lib/crypto";
import { OAUTH_STATE_COOKIE, authorizationUrl, googleConfigured } from "@/core/providers/gmail";

// POST only, so a third-party page cannot start an OAuth flow with a simple link.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  const base = process.env.APP_URL ?? new URL(req.url).origin;
  if (!user) return NextResponse.redirect(new URL("/login", base), 303);
  if (user.isDemo) return NextResponse.redirect(new URL("/app/accounts?gmail=demo", base), 303);
  if (!googleConfigured()) return NextResponse.redirect(new URL("/app/accounts?gmail=unconfigured", base), 303);

  const state = randomToken(24);
  const res = NextResponse.redirect(authorizationUrl(state, user.email), 303);
  res.cookies.set(OAUTH_STATE_COOKIE, `${state}.${user.id}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/gmail",
    maxAge: 600,
  });
  return res;
}
