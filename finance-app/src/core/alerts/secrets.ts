import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Local-only secrets. Values are never logged, never returned by an API, never sent to a cloud model.

function secretFile(): string {
  return process.env.LEDGER_SECRET_FILE ?? join(homedir(), ".ledger", "secrets.env");
}

function parseEnvFile(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      out[key] = val;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadSecret(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const fromFile = parseEnvFile(secretFile())[name];
  return fromFile || undefined;
}

/** IMAP app password. Host/port/user live on the connection row; the password does not. */
export function imapPassword(connectionId?: string): string | undefined {
  if (connectionId) {
    const keyed = loadSecret(`IMAP_PASSWORD_${connectionId}`) ?? loadSecret(`IMAP_PASSWORD_${connectionId.replace(/-/g, "_")}`);
    if (keyed) return keyed;
  }
  return loadSecret("IMAP_PASSWORD") ?? loadSecret("YAHOO_APP_PASSWORD");
}

export function inboundEmailSecret(): string | undefined {
  return loadSecret("INBOUND_EMAIL_SECRET") ?? loadSecret("POSTMARK_INBOUND_SECRET");
}

export function inboundEmailDomain(): string | undefined {
  return loadSecret("INBOUND_EMAIL_DOMAIN") ?? process.env.INBOUND_EMAIL_DOMAIN;
}

export function defaultSyncMinutes(): number {
  const n = Number(process.env.ALERT_SYNC_MINUTES ?? 5);
  return Number.isFinite(n) && n >= 1 && n <= 180 ? n : 5;
}
