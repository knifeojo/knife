import { db } from "./db";
import type { GoogleIdentity } from "@/core/providers/gmail";

/**
 * Resolves a Google identity to an app user.
 * 1. Known Google account → that user.
 * 2. Existing email/password account with the same (Google-verified) email → link and sign in.
 * 3. Otherwise create a new user.
 */
export async function findOrCreateGoogleUser(identity: GoogleIdentity): Promise<{ id: string; created: boolean }> {
  const bySub = await db.user.findUnique({ where: { googleSub: identity.sub } });
  if (bySub) return { id: bySub.id, created: false };

  const byEmail = await db.user.findUnique({ where: { email: identity.email } });
  if (byEmail && !byEmail.isDemo) {
    await db.user.update({ where: { id: byEmail.id }, data: { googleSub: identity.sub, name: byEmail.name ?? identity.name } });
    return { id: byEmail.id, created: false };
  }

  const user = await db.user.create({ data: { email: identity.email, name: identity.name, googleSub: identity.sub } });
  return { id: user.id, created: true };
}
