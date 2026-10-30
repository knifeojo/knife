import { startGmailConnect } from "@/core/email/inboxes";
import { apiError, apiJson, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts Sign in with Google for one more inbox. The phone opens the returned URL. */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  if (auth.user.isDemo) return apiError(400, "Demo mode cannot connect Gmail.");
  try {
    return apiJson(await startGmailConnect(auth.user.id));
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not start Google sign-in";
    const status = /not set|not configured/i.test(message) ? 503 : 400;
    return apiError(status, message);
  }
}
