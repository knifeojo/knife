import { expect, it } from "vitest";
import { buildDemoTransactions } from "@/core/demo";

it("demo data keeps a positive, realistic running balance", () => {
  const txs = buildDemoTransactions(new Date("2026-09-26T12:00:00Z"));
  const min = txs.reduce((m, t) => (t.balanceAfterMinor! < m ? t.balanceAfterMinor! : m), txs[0].balanceAfterMinor!);
  expect(min).toBeGreaterThan(0n);
  const end = txs.at(-1)!.balanceAfterMinor!;
  expect(end).toBeGreaterThan(200_000_000n);
  expect(end).toBeLessThan(900_000_000n);
});
