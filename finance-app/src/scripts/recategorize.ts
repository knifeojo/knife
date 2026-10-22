import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Re-applies the current categorisation rules to one user's existing transactions.
// Rows the user labelled by hand (and own-transfer links) are left as they are.
// Usage: npm run recategorize -- --email you@example.com

function loadDotEnv() {
  const file = resolve(process.cwd(), ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

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
