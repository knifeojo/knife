import { requireApiUser, apiError, bearerToken } from "./http";
import { userIdForSmsToken } from "@/core/alerts/tokens";

/** Session bearer or the personal iOS Shortcuts token (X-Ledger-Sms-Token / X-Ledger-Token). */
export async function requireAlertUser(req: Request): Promise<{ userId: string } | { response: Response }> {
  const header = req.headers.get("x-ledger-sms-token") ?? req.headers.get("x-ledger-token");
  if (header) {
    const userId = await userIdForSmsToken(header.trim());
    if (!userId) return { response: apiError(401, "Sign in required") };
    return { userId };
  }
  const auth = await requireApiUser(req);
  if ("response" in auth) {
    const token = bearerToken(req);
    if (token) {
      const userId = await userIdForSmsToken(token);
      if (userId) return { userId };
    }
    return auth;
  }
  return { userId: auth.user.id };
}
