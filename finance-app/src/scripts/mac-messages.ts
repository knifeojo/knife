import { createRequire } from "node:module";
import { ingestSmsPayload } from "../core/alerts/ingest";
import { BANK_MESSAGES_SQL, bankMessagesFromChatRows, chatDbAvailable, defaultChatDbPath, readAllowlistFile } from "../core/alerts/mac-messages";
import { smsSenderIds } from "../core/alerts/senders";
import { db } from "../lib/db";

// Read-only importer for macOS Messages.app.
// Needs Full Disk Access for Terminal / your Node binary (System Settings → Privacy & Security).
// Never opens non-bank threads: the SQL allowlist is the configured SMS sender IDs.

async function main() {
  const email = process.env.LEDGER_USER_EMAIL;
  if (!email) {
    console.error("Set LEDGER_USER_EMAIL to the Ledger account that should receive these alerts.");
    process.exit(1);
  }
  const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    console.error("No Ledger user with that email.");
    process.exit(1);
  }
  const dbPath = defaultChatDbPath();
  if (!chatDbAvailable(dbPath)) {
    console.error(`Messages database not found at ${dbPath}. Grant Full Disk Access and try again.`);
    process.exit(1);
  }
  const senders = readAllowlistFile();
  let Database: new (path: string, opts?: { readonly?: boolean }) => { prepare: (sql: string) => { all: (...args: unknown[]) => Record<string, unknown>[] } };
  try {
    Database = createRequire(import.meta.url)("better-sqlite3");
  } catch {
    console.error("Install better-sqlite3 to read chat.db, or copy rows into the JSON importer.");
    process.exit(1);
  }
  const sqlite = new Database(dbPath, { readonly: true });
  const rows = sqlite.prepare(BANK_MESSAGES_SQL).all(JSON.stringify(senders.length ? senders : smsSenderIds())) as {
    id: number; sender: string; text: string | null; attributedBody: Buffer | null; date: number;
  }[];
  const messages = bankMessagesFromChatRows(rows, senders);
  let created = 0;
  let skipped = 0;
  for (const m of messages) {
    const r = await ingestSmsPayload(user.id, { sender: m.sender, body: m.text, receivedAt: m.date.toISOString(), sourceId: `mac:${m.id}` });
    if (r.status === "created") created++;
    else skipped++;
  }
  console.log(`Imported ${messages.length} bank messages: ${created} new, ${skipped} already seen or skipped.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
