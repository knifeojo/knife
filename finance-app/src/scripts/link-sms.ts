import { loadDotEnv } from "./dotenv";

// Links an existing SMS to the one unclaimed statement row the dedup rule now matches.
// Dry-run unless --apply. Prints Lagos date, direction and amount only.
// Usage: npm run alerts:link-sms
//        npm run alerts:link-sms -- --apply

async function main() {
  loadDotEnv();
  const apply = process.argv.includes("--apply");
  const { db } = await import("../lib/db");
  const { backfillStatementCoverage } = await import("../core/alerts/coverage");
  const { applySmsStatementLinks, formatLinkLine, planSmsStatementLinks } = await import("../core/alerts/link-sms");
  try {
    await backfillStatementCoverage();
    const planned = await planSmsStatementLinks();
    for (const link of planned) console.log(formatLinkLine(link));
    if (!apply) {
      console.log(`Dry run: ${planned.length} SMS would link to a statement row. Pass --apply to write.`);
      return;
    }
    const applied = await applySmsStatementLinks(planned);
    console.log(`Applied ${applied} links.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "link failed");
  process.exit(1);
});
