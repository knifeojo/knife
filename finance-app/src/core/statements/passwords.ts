import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { log } from "@/lib/log";

// Per-bank PDF passwords. Ciphertext lives in a local file (mode 0600), sealed with
// STATEMENT_PASSWORD_KEY or, if that is unset, ENCRYPTION_KEY. Never written to the database,
// never logged, never returned by an API, never sent to a cloud model.

interface Entry {
  userId: string;
  institution: string;
  ciphertext: string;
}

interface Store {
  version: 1;
  entries: Entry[];
}

export function statementPasswordFile(): string {
  return process.env.STATEMENT_PASSWORD_FILE ?? join(homedir(), ".ledger", "statement-passwords.json");
}

function key(): Buffer {
  const raw = process.env.STATEMENT_PASSWORD_KEY || process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("STATEMENT_PASSWORD_KEY or ENCRYPTION_KEY is not set");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("Statement password key must be 32 bytes, base64 encoded");
  return buf;
}

/** AES-256-GCM, same framing as OAuth tokens (`v1.iv.tag.ciphertext`). The plaintext is never logged. */
export function sealSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function openSecret(payload: string): string {
  const [v, iv, tag, ct] = payload.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export function sealBytes(bytes: Buffer): string {
  return sealSecret(bytes.toString("base64"));
}

export function openBytes(payload: string): Buffer {
  return Buffer.from(openSecret(payload), "base64");
}

function emptyStore(): Store {
  return { version: 1, entries: [] };
}

function readStore(): Store {
  try {
    const parsed = JSON.parse(readFileSync(statementPasswordFile(), "utf8")) as Store;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return emptyStore();
    return parsed;
  } catch {
    return emptyStore();
  }
}

function writeStore(store: Store) {
  const path = statementPasswordFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // The file was already created mode 0600.
  }
}

export function hasStatementPassword(userId: string, institution: string): boolean {
  return readStore().entries.some((entry) => entry.userId === userId && entry.institution === institution);
}

/** Decrypted passwords for this user. The hinted bank comes first. Callers must not log the result. */
export function passwordsForInstitution(userId: string, institution?: string): string[] {
  const entries = readStore().entries.filter((entry) => entry.userId === userId);
  const ordered = institution
    ? [...entries.filter((entry) => entry.institution.toLowerCase() === institution.toLowerCase()), ...entries.filter((entry) => entry.institution.toLowerCase() !== institution.toLowerCase())]
    : entries;
  const out: string[] = [];
  for (const entry of ordered) {
    try {
      const plain = openSecret(entry.ciphertext);
      if (plain) out.push(plain);
    } catch {
      // A row sealed with a rotated key is skipped, not logged.
    }
  }
  return out;
}

export function saveStatementPassword(userId: string, institution: string, password: string): void {
  const trimmed = password.slice(0, 200);
  if (!trimmed) return;
  const store = readStore();
  const ciphertext = sealSecret(trimmed);
  const next = store.entries.filter((entry) => !(entry.userId === userId && entry.institution === institution));
  next.push({ userId, institution, ciphertext });
  writeStore({ version: 1, entries: next });
  log.info("statement.password_saved", { userId, institution });
}

export function forgetStatementPassword(userId: string, institution: string): void {
  const store = readStore();
  const next = store.entries.filter((entry) => !(entry.userId === userId && entry.institution === institution));
  if (next.length === store.entries.length) return;
  writeStore({ version: 1, entries: next });
  log.info("statement.password_removed", { userId, institution });
}

export function forgetAllStatementPasswords(userId: string): void {
  const store = readStore();
  const next = store.entries.filter((entry) => entry.userId !== userId);
  if (next.length === store.entries.length) return;
  writeStore({ version: 1, entries: next });
}
