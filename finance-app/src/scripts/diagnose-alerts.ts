import { loadDotEnv } from "./dotenv";

// Dry-run: print a structural fingerprint for each alert email that fails to parse.
// Subject digits are masked; only sender and field labels are listed. No values, no import.
// Usage: npm run alerts:diagnose

async function main() {
  loadDotEnv();
  const { db } = await import("../lib/db");
  const { ImapEmailSource, decodeImapMessageId } = await import("../core/alerts/imap");
  const { diagnoseFailedEmail, diagnoseHeldReasonCounts } = await import("../core/alerts/diagnose");
  const { INITIAL_LOOKBACK_DAYS } = await import("../core/sources");
  try {
    const conns = await db.financialConnection.findMany({
      where: { status: "active", provider: "imap" },
      select: { id: true, userId: true, imapHost: true, imapPort: true, imapUser: true },
    });
    if (!conns.length) {
      console.log("No active IMAP connection. Save host, port and username on Accounts first.");
      console.log(await diagnoseHeldReasonCounts());
      return;
    }
    const after = new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86400_000);
    let failed = 0;
    let scanned = 0;
    for (const conn of conns) {
      const source = ImapEmailSource.fromConnection(conn);
      await source.beginSession();
      try {
        const cursors: Record<string, { uid: number; uidValidity?: string }> = {};
        const page = 200;
        while (true) {
          const ids = await source.listMessageIds({ query: "", after, max: page, folderCursors: cursors });
          if (!ids.length) break;
          for (const id of ids) {
            const email = await source.getMessage(id);
            scanned++;
            const line = diagnoseFailedEmail(email);
            if (line) {
              console.log(line);
              failed++;
            }
            const parsed = decodeImapMessageId(id);
            if (parsed) {
              cursors[parsed.folder] = {
                uid: parsed.uid,
                uidValidity: source.folderUidValidity?.(parsed.folder) ?? cursors[parsed.folder]?.uidValidity,
              };
            }
          }
          if (ids.length < page) break;
        }
      } finally {
        await source.endSession();
      }
    }
    const users = [...new Set(conns.map((c) => c.userId))];
    for (const userId of users) console.log(await diagnoseHeldReasonCounts(userId));
    console.log(`Diagnose: ${failed} failed of ${scanned} scanned. Nothing was imported.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "diagnose failed");
  process.exit(1);
});
