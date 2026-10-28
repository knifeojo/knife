import "server-only";
import { db } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { log } from "@/lib/log";
import { emailFieldsFromGmailResource } from "../alerts/attachments";
import type { EmailMessage } from "../types";
import type { EmailSource } from "./types";

// Gmail read-only integration. Uses fetch against Google's REST endpoints; tokens never leave the server.

export const OAUTH_STATE_COOKIE = "fa_oauth_state";
export const GMAIL_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"];
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function googleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export const GMAIL_CALLBACK = "/api/gmail/callback";
export const SIGNIN_CALLBACK = "/api/auth/google/callback";
/** Sign-in asks for identity only. Gmail access is a separate, explicit consent step. */
export const SIGNIN_SCOPES = ["openid", "email", "profile"];

export function redirectUri(path = GMAIL_CALLBACK): string {
  return `${process.env.APP_URL ?? "http://localhost:3000"}${path}`;
}

export function authorizationUrl(state: string, loginHint?: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(GMAIL_CALLBACK),
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export function signInUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(SIGNIN_CALLBACK),
    response_type: "code",
    scope: SIGNIN_SCOPES.join(" "),
    prompt: "select_account",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  id_token?: string;
}

export async function exchangeCode(code: string, callbackPath = GMAIL_CALLBACK): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(callbackPath),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return res.json();
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string;
}

/**
 * Reads the ID token returned by Google's token endpoint. It came to us directly from Google over
 * TLS in the code exchange, so per OpenID Connect we validate claims rather than the signature.
 */
export function identityFromIdToken(idToken: string | undefined): GoogleIdentity {
  if (!idToken) throw new Error("missing id_token");
  const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
  if (payload.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error("id_token audience mismatch");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(payload.iss)) throw new Error("id_token issuer mismatch");
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) throw new Error("id_token expired");
  if (!payload.email || payload.email_verified !== true) throw new Error("Google email not verified");
  return { sub: String(payload.sub), email: String(payload.email).toLowerCase(), name: payload.name };
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
}

/** Returns a valid access token for the connection, refreshing and re-encrypting when needed. */
async function accessTokenFor(connectionId: string): Promise<string> {
  const conn = await db.financialConnection.findUniqueOrThrow({ where: { id: connectionId } });
  if (conn.encryptedAccessToken && conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() > Date.now() + 60_000) {
    return decrypt(conn.encryptedAccessToken);
  }
  if (!conn.encryptedRefreshToken) throw new Error("Gmail connection has no refresh token; reconnect required");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: decrypt(conn.encryptedRefreshToken),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    log.warn("gmail.refresh_failed", { connectionId, status: res.status });
    await db.financialConnection.update({ where: { id: connectionId }, data: { status: "error", lastError: "Google access expired or was revoked. Reconnect Gmail." } });
    throw new Error("Gmail authorization expired; reconnect required");
  }
  const t: TokenResponse = await res.json();
  await db.financialConnection.update({
    where: { id: connectionId },
    data: { encryptedAccessToken: encrypt(t.access_token), accessTokenExpiresAt: new Date(Date.now() + t.expires_in * 1000) },
  });
  return t.access_token;
}

export async function gmailProfile(accessToken: string): Promise<{ emailAddress: string; historyId: string }> {
  const res = await fetch(`${GMAIL_API}/profile`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`gmail profile failed: ${res.status}`);
  return res.json();
}

export class GmailEmailSource implements EmailSource {
  readonly source = "gmail" as const;
  constructor(private readonly connectionId: string) {}

  private async get(path: string) {
    const token = await accessTokenFor(this.connectionId);
    const res = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`gmail ${res.status}`);
    return res.json();
  }

  async listMessageIds({ query, after, max = 500 }: { query: string; after?: Date; max?: number }) {
    const q = after ? `${query} after:${Math.floor(after.getTime() / 1000)}` : query;
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, maxResults: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await this.get(`/messages?${params}`);
      for (const m of page.messages ?? []) ids.push(m.id);
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < max);
    return ids.slice(0, max);
  }

  /** Incremental: message ids added since historyId. `stale` means the cursor is too old — fall back to after-date. */
  async listHistoryMessageIds(startHistoryId: string): Promise<{ ids: string[]; historyId?: string; stale?: boolean }> {
    try {
      const ids = new Set<string>();
      let pageToken: string | undefined;
      let newest: string | undefined;
      do {
        const params = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", maxResults: "100" });
        if (pageToken) params.set("pageToken", pageToken);
        const token = await accessTokenFor(this.connectionId);
        const res = await fetch(`${GMAIL_API}/history?${params}`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 404 || res.status === 410) return { ids: [], stale: true };
        if (!res.ok) throw new Error(`gmail ${res.status}`);
        const page = await res.json();
        for (const h of page.history ?? []) {
          for (const added of h.messagesAdded ?? []) if (added.message?.id) ids.add(added.message.id);
        }
        newest = page.historyId ?? newest;
        pageToken = page.nextPageToken;
      } while (pageToken);
      return { ids: [...ids], historyId: newest };
    } catch (e) {
      if (String(e).includes("404") || String(e).includes("410")) return { ids: [], stale: true };
      throw e;
    }
  }

  async fetchAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const json = await this.get(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`) as { data?: string };
    if (!json.data) return Buffer.alloc(0);
    return Buffer.from(json.data, "base64url");
  }

  async getMessage(id: string): Promise<EmailMessage> {
    const msg = await this.get(`/messages/${id}?format=full`);
    const fields = emailFieldsFromGmailResource(msg);
    return { ...fields, id };
  }
}
