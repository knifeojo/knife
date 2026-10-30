import { finishGmailConnect, isWebGmailState } from "@/core/email/inboxes";
import { syncOneConnection } from "@/core/alerts/scheduler";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
}

/** Opens the installed app. address is set on success; error is a short code when it failed. */
export function returnToLedgerLink(input: { address?: string; error?: string } = {}): string {
  const params = new URLSearchParams();
  if (input.address) params.set("address", input.address);
  if (input.error) params.set("error", input.error);
  const query = params.toString();
  return `ledger://email-connected${query ? `?${query}` : ""}`;
}

export function gmailCallbackPage(status: number, title: string, body: string, link: string) {
  const href = escapeHtml(link);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta http-equiv="refresh" content="0;url=${href}"></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p><a href="${href}">Return to Ledger</a></p><script>location.replace(${JSON.stringify(link)})</script></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** Where the website lives. Not the Google redirect_uri. */
export function accountsReturnUrl(query: string): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/app/accounts?${query}`;
}

function webAccounts(query: string) {
  return NextResponse.redirect(accountsReturnUrl(query), 303);
}

/** Google redirects the browser here. PUBLIC_BASE_URL must be the registered redirect origin. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const state = params.get("state") ?? "";
  const code = params.get("code");
  const web = isWebGmailState(state);

  if (params.get("error") || !state || !code) {
    if (state) await db.emailOAuthState.deleteMany({ where: { state } });
    if (web) return webAccounts(params.get("error") ? "gmail=denied" : "gmail=error&reason=code");
    const error = params.get("error") ? "denied" : "incomplete";
    const message = params.get("error")
      ? "Google did not grant access. Try Add email again from Ledger."
      : "The sign-in link was incomplete. Start again from Ledger.";
    return gmailCallbackPage(400, "Gmail was not connected", message, returnToLedgerLink({ error }));
  }

  try {
    const saved = await finishGmailConnect({ state, code });
    let scanned = 0;
    let found = 0;
    let failed = 0;
    try {
      const summary = await syncOneConnection(saved.financialConnectionId);
      scanned = summary?.emailsScanned ?? 0;
      found = summary?.created ?? 0;
      failed = summary?.parseFailures ?? 0;
    } catch (e) {
      log.warn("email.gmail_first_sync_failed", { error: e instanceof Error ? e.message : "unknown" });
    }
    if (web) return webAccounts(`gmail=connected&found=${found}&scanned=${scanned}&failed=${failed}`);
    return gmailCallbackPage(200, "Gmail connected", `${saved.address} is connected. Ledger is reading the last 12 months of bank mail.`, returnToLedgerLink({ address: saved.address }));
  } catch (e) {
    log.warn("email.gmail_callback_failed", { error: e instanceof Error ? e.message : "unknown" });
    if (web) return webAccounts("gmail=error&reason=exchange");
    return gmailCallbackPage(400, "Gmail was not connected", "Ledger could not finish Sign in with Google. Start again from the app.", returnToLedgerLink({ error: "failed" }));
  }
}
