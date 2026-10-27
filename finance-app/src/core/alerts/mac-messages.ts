import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAllowedSmsSender, smsSenderIds } from "./senders";

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

export interface MacMessageRow {
  id: string;
  sender: string;
  text: string;
  date: Date;
}

/** Apple stores iMessage dates as nanoseconds (sometimes seconds) since 2001-01-01. */
export function appleDate(raw: number | bigint): Date {
  const n = typeof raw === "bigint" ? Number(raw) : raw;
  const ms = n > 1e12 ? n / 1e6 : n > 1e9 ? n / 1e6 : n * 1000;
  return new Date(APPLE_EPOCH_MS + ms);
}

/**
 * Pull a UTF-8 string out of NSKeyedArchiver `attributedBody` when `text` is null.
 * Only used for already-filtered bank sender rows.
 */
export function attributedBodyText(buf: Buffer | Uint8Array | null | undefined): string {
  if (!buf || !buf.length) return "";
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const asUtf8 = raw.toString("utf8");
  const marker = asUtf8.indexOf("NSString");
  const slice = marker >= 0 ? asUtf8.slice(marker) : asUtf8;
  const printable = slice.replace(/[^\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]/g, " ");
  const runs = printable
    .split(/\s{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && /Amt:|Debit:|Credit:|Money (In|Out)|Acct:|Bal:/i.test(s));
  if (runs[0]) return runs[0];
  const fallback = printable.match(/(Acct:[\s\S]{20,400}|Debit:[\s\S]{20,400}|Credit:[\s\S]{20,400}|Money (?:In|Out)![\s\S]{20,400})/i);
  return fallback?.[0]?.trim() ?? "";
}

export function bankMessagesFromChatRows(
  rows: { id: string | number; sender: string; text?: string | null; attributedBody?: Buffer | null; date: number | bigint }[],
  allowed = smsSenderIds(),
): MacMessageRow[] {
  const allow = new Set(allowed.map((s) => s.toLowerCase()));
  const out: MacMessageRow[] = [];
  for (const row of rows) {
    if (!isAllowedSmsSender(row.sender) && !allow.has(row.sender.toLowerCase())) continue;
    const text = (row.text && row.text.trim()) || attributedBodyText(row.attributedBody);
    if (!text) continue;
    out.push({ id: String(row.id), sender: row.sender, text, date: appleDate(row.date) });
  }
  return out;
}

export function defaultChatDbPath(): string {
  return process.env.MAC_MESSAGES_DB ?? join(homedir(), "Library", "Messages", "chat.db");
}

export function chatDbAvailable(path = defaultChatDbPath()): boolean {
  return existsSync(path);
}

/** Read-only SQL. Callers open sqlite3 themselves (see src/scripts/mac-messages.ts). */
export const BANK_MESSAGES_SQL = `
SELECT m.ROWID AS id, h.id AS sender, m.text AS text, m.attributedBody AS attributedBody, m.date AS date
FROM message m
JOIN handle h ON h.ROWID = m.handle_id
WHERE m.is_from_me = 0
  AND lower(h.id) IN (SELECT lower(value) FROM json_each(?))
ORDER BY m.date ASC
`;

export function readAllowlistFile(path?: string): string[] {
  const p = path ?? process.env.SMS_SENDERS_FILE;
  if (!p) return smsSenderIds();
  try {
    return readFileSync(p, "utf8").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return smsSenderIds();
  }
}
