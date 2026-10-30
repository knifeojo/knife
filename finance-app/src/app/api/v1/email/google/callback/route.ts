import { finishGmailConnect } from "@/core/email/inboxes";
import { syncOneConnection } from "@/core/alerts/scheduler";
import { log } from "@/lib/log";

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

/** Google redirects the browser here. PUBLIC_BASE_URL must be the registered redirect origin. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  if (params.get("error")) {
    return gmailCallbackPage(400, "Gmail was not connected", "Google did not grant access. Try Add email again from Ledger.", returnToLedgerLink({ error: "denied" }));
  }
  const state = params.get("state");
  const code = params.get("code");
  if (!state || !code) {
    return gmailCallbackPage(400, "Gmail was not connected", "The sign-in link was incomplete. Start again from Ledger.", returnToLedgerLink({ error: "incomplete" }));
  }
  try {
    const saved = await finishGmailConnect({ state, code });
    try {
      await syncOneConnection(saved.financialConnectionId);
    } catch (e) {
      log.warn("email.gmail_first_sync_failed", { error: e instanceof Error ? e.message : "unknown" });
    }
    return gmailCallbackPage(200, "Gmail connected", `${saved.address} is connected. Ledger is reading the last 12 months of bank mail.`, returnToLedgerLink({ address: saved.address }));
  } catch (e) {
    log.warn("email.gmail_callback_failed", { error: e instanceof Error ? e.message : "unknown" });
    return gmailCallbackPage(400, "Gmail was not connected", "Ledger could not finish Sign in with Google. Start again from the app.", returnToLedgerLink({ error: "failed" }));
  }
}
