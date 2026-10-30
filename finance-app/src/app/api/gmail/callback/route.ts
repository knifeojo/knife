import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { log } from "@/lib/log";
import { syncEmailSource } from "@/core/ledger";
import { saveGmailInbox } from "@/core/email/inboxes";
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
    const saved = await saveGmailInbox(user.id, {
      address: profile.emailAddress,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
      historyId: profile.historyId,
    });

    // First scan right away so the user lands on a populated dashboard.
    const r = await syncEmailSource(user.id, saved.financialConnectionId, new GmailEmailSource(saved.financialConnectionId));
    return back(`gmail=connected&found=${r.created}&scanned=${r.emailsScanned}&failed=${r.parseFailures}`);
  } catch (e) {
    log.error("gmail.callback_failed", { userId: user.id, error: e instanceof Error ? e.message : "unknown" });
    return back("gmail=error&reason=exchange");
  }
}
