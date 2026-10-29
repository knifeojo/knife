import { loadDotEnv } from "./dotenv";

// Dry-run: list candidate statement emails on the connected IMAP account.
// Prints date, sender, folder and attachment names. No bodies, no import.
// Usage: npm run alerts:list-statements

async function main() {
  loadDotEnv();
  const { db } = await import("../lib/db");
  const { ImapEmailSource, formatStatementCandidateLine } = await import("../core/alerts/imap");
  const { INITIAL_LOOKBACK_DAYS } = await import("../core/sources");
  try {
    const conns = await db.financialConnection.findMany({
      where: { status: "active", provider: "imap" },
      select: { id: true, userId: true, imapHost: true, imapPort: true, imapUser: true },
    });
    if (!conns.length) {
      console.log("No active IMAP connection. Save host, port and username on Accounts first.");
      return;
    }
    const after = new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86400_000);
    let listed = 0;
    for (const conn of conns) {
      const source = ImapEmailSource.fromConnection(conn);
      await source.beginSession();
      try {
        const rows = await source.listStatementCandidates({ after });
        for (const row of rows) {
          console.log(formatStatementCandidateLine(row));
          listed++;
        }
        if (!rows.length) console.log(`No statement candidates in the last ${INITIAL_LOOKBACK_DAYS} days for ${conn.imapUser ?? conn.id}.`);
      } finally {
        await source.endSession();
      }
    }
    console.log(`Dry run: ${listed} candidate statement email(s). Nothing was imported.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "list failed");
  process.exit(1);
});
