import { loadDotEnv } from "./dotenv";

// Re-applies the current categorisation rules to one user's existing transactions.
// Rows the user labelled by hand (and own-transfer links) are left as they are.
// Usage: npm run recategorize -- --email you@example.com

function emailFrom(argv: string[]): string | undefined {
  const index = argv.indexOf("--email");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

async function main() {
  loadDotEnv();
  const email = emailFrom(process.argv);
  if (!email) {
    console.error("Usage: npm run recategorize -- --email you@example.com");
    process.exit(1);
  }
  const { db } = await import("../lib/db");
  const { reapplyCategories } = await import("../core/ledger");
  try {
    const user = await db.user.findUnique({ where: { email } });
    if (!user) {
      console.error(`No user with email ${email}`);
      process.exit(1);
    }
    const result = await reapplyCategories(user.id);
    console.log(`Checked ${result.checked} transactions, updated ${result.changed}. Categories set by hand were left unchanged.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "recategorize failed");
  process.exit(1);
});
