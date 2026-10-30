import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionFromToken } from "@/lib/auth";
import { gmailConnectConfigured, startGmailConnect } from "@/core/email/inboxes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cookieValue(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function siteUrl(path: string): URL {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return new URL(path, `${base}/`);
}

// POST only, so a third-party page cannot start an OAuth flow with a simple link.
// Google is sent to PUBLIC_BASE_URL + /api/v1/email/google/callback, never APP_URL or this request's host.
export async function POST(req: Request) {
  const session = await sessionFromToken(cookieValue(req, SESSION_COOKIE));
  const user = session?.user ?? null;
  if (!user) return NextResponse.redirect(siteUrl("/login"), 303);
  if (user.isDemo) return NextResponse.redirect(siteUrl("/app/accounts?gmail=demo"), 303);
  if (!gmailConnectConfigured()) return NextResponse.redirect(siteUrl("/app/accounts?gmail=unconfigured"), 303);

  try {
    const { url } = await startGmailConnect(user.id, { web: true });
    return NextResponse.redirect(url, 303);
  } catch {
    return NextResponse.redirect(siteUrl("/app/accounts?gmail=unconfigured"), 303);
  }
}
