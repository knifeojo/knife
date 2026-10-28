import { loadDotEnv } from "./dotenv";

// Sets statement coverage from existing statement rows. Does not open review flags.
// Usage: npm run alerts:backfill-coverage

async function main() {
  loadDotEnv();
  const { db } = await import("../lib/db");
  const { backfillStatementCoverage } = await import("../core/alerts/coverage");
  try {
    const result = await backfillStatementCoverage();
    console.log(`Statement coverage: ${result.updated} accounts updated, ${result.accounts} with statement rows.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "backfill failed");
  process.exit(1);
});
