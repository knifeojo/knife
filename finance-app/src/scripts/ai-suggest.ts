import { loadDotEnv } from "./dotenv";

// Asks the configured AI (local Ollama by default) for category suggestions on the backlog of
// transactions the rules could not label. Suggestions wait in Review until the owner confirms them.
// Usage: npm run ai:suggest -- --limit 50 [--dry-run]

async function main() {
  loadDotEnv();
  const { parseSuggestArgs, runSuggestCli } = await import("../core/ai/batch");
  const { db } = await import("../lib/db");
  try {
    const code = await runSuggestCli(parseSuggestArgs(process.argv.slice(2)), { out: console.log, err: console.error });
    process.exitCode = code;
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "ai:suggest failed");
  process.exit(1);
});
