import { finishGmailConnect } from "@/core/email/inboxes";
import { syncOneConnection } from "@/core/alerts/scheduler";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
}

function page(status: number, title: string, body: string) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

/** Google redirects the browser here. PUBLIC_BASE_URL must be the registered redirect origin. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  if (params.get("error")) return page(400, "Gmail was not connected", "Google did not grant access. You can close this window and try Add email again.");
  const state = params.get("state");
  const code = params.get("code");
  if (!state || !code) return page(400, "Gmail was not connected", "The sign-in link was incomplete. Start again from Ledger.");
  try {
    const saved = await finishGmailConnect({ state, code });
    try {
      await syncOneConnection(saved.financialConnectionId);
    } catch (e) {
      log.warn("email.gmail_first_sync_failed", { error: e instanceof Error ? e.message : "unknown" });
    }
    return page(200, "Gmail connected", `${saved.address} is connected. You can close this window and return to Ledger.`);
  } catch (e) {
    log.warn("email.gmail_callback_failed", { error: e instanceof Error ? e.message : "unknown" });
    return page(400, "Gmail was not connected", "Ledger could not finish Sign in with Google. Start again from the app.");
  }
}
