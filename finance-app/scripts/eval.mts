// Accuracy scorecard for one user: how often automatic categorization matches what the user said.
// Usage: npx tsx --tsconfig tsconfig.json scripts/eval.mts <email>
import { db } from "../src/lib/db.ts";
import { scoreUser } from "../src/core/eval.ts";
const email = process.argv[2];
const u = await db.user.findFirstOrThrow({ where: { email } });
const c = await scoreUser(u.id);
const N = (m: bigint) => "₦" + (Number(m) / 100).toLocaleString("en-NG", { maximumFractionDigits: 0 });
console.log(`${c.method}: ${c.correct}/${c.labelled} right (${(c.accuracy * 100).toFixed(1)}% by count, ${(c.valueAccuracy * 100).toFixed(1)}% by value) | spending in a specific category: ${(c.coverage * 100).toFixed(1)}%`);
for (const m of c.mistakes) console.log(`  expected ${m.expected.padEnd(13)} got ${m.got.padEnd(13)} ${N(m.amountMinor).padStart(11)}  ${m.description.replace(/\d{8,}/g, "…").slice(0, 60)}`);
await db.$disconnect();
