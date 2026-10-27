import { db } from "@/lib/db";
import { randomToken } from "@/lib/crypto";
import { inboundEmailDomain } from "./secrets";

export async function ensureUserTokens(userId: string): Promise<{ inboundEmailToken: string; smsIngestToken: string }> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { inboundEmailToken: true, smsIngestToken: true } });
  const inboundEmailToken = user.inboundEmailToken ?? randomToken(18);
  const smsIngestToken = user.smsIngestToken ?? randomToken(18);
  if (!user.inboundEmailToken || !user.smsIngestToken) {
    await db.user.update({
      where: { id: userId },
      data: {
        inboundEmailToken: user.inboundEmailToken ?? inboundEmailToken,
        smsIngestToken: user.smsIngestToken ?? smsIngestToken,
      },
    });
  }
  return { inboundEmailToken: user.inboundEmailToken ?? inboundEmailToken, smsIngestToken: user.smsIngestToken ?? smsIngestToken };
}

export function inboundAddress(token: string): string | null {
  const domain = inboundEmailDomain();
  if (!domain) return null;
  return `alerts-${token}@${domain}`;
}

export function tokenFromRecipient(to: string): string | undefined {
  const m = to.match(/alerts-([A-Za-z0-9_-]{8,80})@/i);
  return m?.[1];
}

export async function userIdForInboundToken(token: string): Promise<string | undefined> {
  const user = await db.user.findUnique({ where: { inboundEmailToken: token }, select: { id: true } });
  return user?.id;
}

export async function userIdForSmsToken(token: string): Promise<string | undefined> {
  const user = await db.user.findUnique({ where: { smsIngestToken: token }, select: { id: true } });
  return user?.id;
}
