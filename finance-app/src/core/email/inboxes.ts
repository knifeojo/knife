import { db } from "@/lib/db";
import { decrypt, encrypt, randomToken } from "@/lib/crypto";
import { log } from "@/lib/log";
import {
  GMAIL_READONLY_SCOPE,
  MOBILE_GMAIL_CALLBACK,
  authorizationUrl,
  exchangeCode,
  gmailProfile,
  googleConfigured,
  publicBaseUrl,
  revokeToken,
} from "../providers/gmail";

const FORBIDDEN_SCOPES = /gmail\.(send|modify|compose|insert|labels)|mail\.google\.com/;

export function assertGmailReadonly(scope: string): void {
  const granted = scope.split(/\s+/).filter(Boolean);
  if (!granted.includes(GMAIL_READONLY_SCOPE)) throw new Error("Google did not grant read-only Gmail access");
  if (granted.some((item) => FORBIDDEN_SCOPES.test(item))) throw new Error("Google granted more than read-only access");
}

function addressOf(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 200);
}

/** Stores an encrypted refresh token on EmailConnection and the sync row the scheduler already runs. */
export async function saveGmailInbox(
  userId: string,
  input: {
    address: string;
    accessToken: string;
    refreshToken?: string | null;
    expiresIn: number;
    scope: string;
    historyId?: string | null;
  },
) {
  assertGmailReadonly(input.scope);
  const address = addressOf(input.address);
  if (!address.includes("@")) throw new Error("Gmail did not return an email address");
  const tokenFields = {
    status: "active" as const,
    lastError: null,
    scope: input.scope,
    encryptedAccessToken: encrypt(input.accessToken),
    accessTokenExpiresAt: new Date(Date.now() + input.expiresIn * 1000),
    ...(input.refreshToken ? { encryptedRefreshToken: encrypt(input.refreshToken) } : {}),
  };
  const financial = await db.financialConnection.upsert({
    where: { userId_provider_providerAccountId: { userId, provider: "gmail", providerAccountId: address } },
    update: { ...tokenFields, gmailHistoryId: input.historyId ?? undefined },
    create: {
      userId,
      provider: "gmail",
      providerAccountId: address,
      ...tokenFields,
      gmailHistoryId: input.historyId ?? null,
      encryptedRefreshToken: input.refreshToken ? encrypt(input.refreshToken) : null,
    },
  });
  const email = await db.emailConnection.upsert({
    where: { userId_address: { userId, address } },
    update: { provider: "gmail", ...tokenFields, historyId: input.historyId ?? undefined, financialConnectionId: financial.id },
    create: {
      userId,
      provider: "gmail",
      address,
      ...tokenFields,
      historyId: input.historyId ?? null,
      financialConnectionId: financial.id,
      encryptedRefreshToken: input.refreshToken ? encrypt(input.refreshToken) : null,
    },
  });
  log.info("email.gmail_connected", { userId, address });
  return { id: email.id, address, financialConnectionId: financial.id };
}

/** IMAP and Yahoo. The app password stays in the local secret file, not in this row. */
export async function saveImapInbox(userId: string, input: { host: string; port: number; user: string }) {
  const address = addressOf(input.user);
  const financial = await db.financialConnection.upsert({
    where: { userId_provider_providerAccountId: { userId, provider: "imap", providerAccountId: address } },
    update: { imapHost: input.host, imapPort: input.port, imapUser: input.user, providerAccountId: address, status: "active", lastError: null },
    create: { userId, provider: "imap", providerAccountId: address, imapHost: input.host, imapPort: input.port, imapUser: input.user, status: "active" },
  });
  const email = await db.emailConnection.upsert({
    where: { userId_address: { userId, address } },
    update: { provider: "imap", imapHost: input.host, imapPort: input.port, status: "active", lastError: null, financialConnectionId: financial.id },
    create: { userId, provider: "imap", address, imapHost: input.host, imapPort: input.port, status: "active", financialConnectionId: financial.id },
  });
  return { id: email.id, address, financialConnectionId: financial.id };
}

export async function listEmailConnections(userId: string) {
  await backfillEmailConnections(userId);
  const rows = await db.emailConnection.findMany({
    where: { userId, status: { not: "revoked" } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    address: row.address,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastError: row.lastError,
  }));
}

/** Older installs stored the one Gmail or IMAP row only on FinancialConnection. */
async function backfillEmailConnections(userId: string) {
  const existing = await db.emailConnection.findMany({ where: { userId }, select: { address: true, financialConnectionId: true } });
  const known = new Set(existing.map((row) => row.address));
  const linked = new Set(existing.map((row) => row.financialConnectionId).filter(Boolean));
  const fins = await db.financialConnection.findMany({
    where: { userId, provider: { in: ["gmail", "imap"] }, status: { not: "revoked" } },
  });
  for (const fin of fins) {
    const address = addressOf(fin.providerAccountId || fin.imapUser || "");
    if (!address || known.has(address) || linked.has(fin.id)) continue;
    await db.emailConnection.create({
      data: {
        userId,
        provider: fin.provider,
        address,
        status: fin.status,
        encryptedRefreshToken: fin.encryptedRefreshToken,
        encryptedAccessToken: fin.encryptedAccessToken,
        accessTokenExpiresAt: fin.accessTokenExpiresAt,
        scope: fin.scope,
        historyId: fin.gmailHistoryId,
        imapHost: fin.imapHost,
        imapPort: fin.imapPort,
        lastSyncedAt: fin.lastSyncedAt,
        lastError: fin.lastError,
        financialConnectionId: fin.id,
      },
    });
    known.add(address);
  }
}

export async function removeEmailConnection(userId: string, id: string): Promise<boolean> {
  const row = await db.emailConnection.findFirst({ where: { id, userId } });
  if (!row || row.status === "revoked") return false;
  const token = row.encryptedRefreshToken ?? row.encryptedAccessToken;
  if (token) {
    try {
      await revokeToken(decrypt(token));
    } catch {
      // Revoke is best-effort. The row is still removed from the list.
    }
  }
  await db.emailConnection.update({
    where: { id: row.id },
    data: { status: "revoked", encryptedAccessToken: null, encryptedRefreshToken: null, accessTokenExpiresAt: null },
  });
  if (row.financialConnectionId) {
    await db.financialConnection.update({
      where: { id: row.financialConnectionId },
      data: { status: "revoked", encryptedAccessToken: null, encryptedRefreshToken: null, accessTokenExpiresAt: null },
    });
  }
  log.info("email.disconnected", { userId, provider: row.provider });
  return true;
}

export function gmailConnectConfigured(): boolean {
  return googleConfigured() && !!process.env.PUBLIC_BASE_URL?.trim();
}

export async function startGmailConnect(userId: string): Promise<{ url: string }> {
  if (!gmailConnectConfigured()) throw new Error("Google sign-in is not configured.");
  const base = publicBaseUrl();
  const state = randomToken(24);
  await db.emailOAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await db.emailOAuthState.create({ data: { state, userId, expiresAt: new Date(Date.now() + 10 * 60_000) } });
  return { url: authorizationUrl(state, undefined, MOBILE_GMAIL_CALLBACK, base) };
}

export async function finishGmailConnect(input: { state: string; code: string }) {
  if (!gmailConnectConfigured()) throw new Error("Google sign-in is not configured.");
  const pending = await db.emailOAuthState.findUnique({ where: { state: input.state } });
  if (!pending || pending.expiresAt.getTime() < Date.now()) throw new Error("This Google sign-in expired. Start again from Ledger.");
  await db.emailOAuthState.delete({ where: { state: input.state } });
  const base = publicBaseUrl();
  const tokens = await exchangeCode(input.code, MOBILE_GMAIL_CALLBACK, base);
  assertGmailReadonly(tokens.scope);
  const profile = await gmailProfile(tokens.access_token);
  return saveGmailInbox(pending.userId, {
    address: profile.emailAddress,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    historyId: profile.historyId,
  });
}
