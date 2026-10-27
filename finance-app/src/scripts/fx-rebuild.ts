import { loadDotEnv } from "./dotenv";

// Rebuild realised FX rates from every linked pair, fetch missing daily market rates,
// reject outliers, and retag CAD wallet legs stored as USD.
// Usage: npm run fx:rebuild -- --email you@example.com
//        npm run fx:rebuild

function emailFrom(argv: string[]): string | undefined {
  const index = argv.indexOf("--email");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function line(r: { realised: number; rejected: number; retagged: number; marketFetched: number; marketFailed: number }): string {
  return `Stored ${r.realised} realised daily rate${r.realised === 1 ? "" : "s"}, rejected ${r.rejected} outlier pair${r.rejected === 1 ? "" : "s"}, retagged ${r.retagged} CAD leg${r.retagged === 1 ? "" : "s"}, fetched ${r.marketFetched} market day${r.marketFetched === 1 ? "" : "s"} (${r.marketFailed} offline).`;
}

async function main() {
  loadDotEnv();
  const email = emailFrom(process.argv);
  const { db } = await import("../lib/db");
  const { rebuildAllUsersFx, rebuildUserFx } = await import("../core/fx/realised");
  try {
    if (!email) {
      const r = await rebuildAllUsersFx();
      console.log(`Rebuilt FX for every user. ${line(r)}`);
      return;
    }
    const user = await db.user.findUnique({ where: { email } });
    if (!user) {
      console.error(`No user with email ${email}`);
      process.exit(1);
    }
    const r = await rebuildUserFx(user.id);
    console.log(`Rebuilt FX. ${line(r)}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "fx rebuild failed");
  process.exit(1);
});
