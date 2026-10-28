import { loadDotEnv } from "./dotenv";

// Records StatementFile coverage for statements imported before file tracking.
// Idempotent. Does not re-import rows or open review flags.
// Usage: npm run statements:backfill

async function main() {
  loadDotEnv();
  const { db } = await import("../lib/db");
  const { backfillStatementFiles } = await import("../core/statements/backfill");
  try {
    const result = await backfillStatementFiles();
    console.log(`Statement files: ${result.created} created, ${result.updated} updated, ${result.accounts} accounts with statement rows.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "backfill failed");
  process.exit(1);
});
