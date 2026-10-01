import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { log } from "@/lib/log";
import { syncEmailSource } from "@/core/ledger";
import { GmailEmailSource, OAUTH_STATE_COOKIE, exchangeCode, gmailProfile, revokeToken } from "@/core/providers/gmail";

const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const FORBIDDEN_SCOPES = /gmail\.(send|modify|compose|insert|labels)|mail\.google\.com/;

export async function GET(req: NextRequest) {
  const base = process.env.APP_URL ?? req.nextUrl.origin;
  const back = (q: string) => {
    const res = NextResponse.redirect(new URL(`/app/accounts?${q}`, base));
    res.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/gmail" });
    return res;
  };

  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", base));

  const params = req.nextUrl.searchParams;
  const [expectedState, stateUser] = (req.cookies.get(OAUTH_STATE_COOKIE)?.value ?? "").split(".");
  if (!expectedState || params.get("state") !== expectedState || stateUser !== user.id) {
    log.warn("gmail.oauth_state_mismatch", { userId: user.id });
    return back("gmail=error&reason=state");
  }
  if (params.get("error")) return back("gmail=denied");
  const code = params.get("code");
  if (!code) return back("gmail=error&reason=code");

  try {
    const tokens = await exchangeCode(code);
    const granted = tokens.scope.split(" ");
    if (!granted.includes(READONLY)) {
      await revokeToken(tokens.access_token);
      return back("gmail=error&reason=scope");
    }
    if (granted.some((s) => FORBIDDEN_SCOPES.test(s))) {
      // We never want write access. Refuse to store a token that has it.
      await revokeToken(tokens.access_token);
      return back("gmail=error&reason=broad_scope");
    }
    const profile = await gmailProfile(tokens.access_token);
    const existing = await db.financialConnection.findUnique({ where: { userId_provider: { userId: user.id, provider: "gmail" } } });
    const conn = await db.financialConnection.upsert({
      where: { userId_provider: { userId: user.id, provider: "gmail" } },
      update: {
        providerAccountId: profile.emailAddress,
        status: "active",
        lastError: null,
        scope: tokens.scope,
        gmailHistoryId: profile.historyId,
        encryptedAccessToken: encrypt(tokens.access_token),
        accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        ...(tokens.refresh_token ? { encryptedRefreshToken: encrypt(tokens.refresh_token) } : {}),
      },
      create: {
        userId: user.id,
        provider: "gmail",
        providerAccountId: profile.emailAddress,
        scope: tokens.scope,
        gmailHistoryId: profile.historyId,
        encryptedAccessToken: encrypt(tokens.access_token),
        accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        encryptedRefreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      },
    });
    log.info("gmail.connected", { userId: user.id, reconnect: !!existing });

    // First scan right away so the user lands on a populated dashboard.
    const r = await syncEmailSource(user.id, conn.id, new GmailEmailSource(conn.id));
    return back(`gmail=connected&found=${r.created}&scanned=${r.emailsScanned}&failed=${r.parseFailures}`);
  } catch (e) {
    log.error("gmail.callback_failed", { userId: user.id, error: e instanceof Error ? e.message : "unknown" });
    return back("gmail=error&reason=exchange");
  }
}
