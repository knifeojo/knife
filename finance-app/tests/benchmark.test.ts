import { describe, expect, it } from "vitest";
import { BENCHMARK, OWNER } from "./fixtures/benchmark";
import { rulesClassifier } from "@/core/eval";

export async function benchmarkAccuracy() {
  const rows = BENCHMARK.map((b, i) => ({ id: String(i), description: b.description, type: b.type }));
  const preds = await rulesClassifier(rows, [OWNER]);
  const misses = BENCHMARK.filter((b, i) => preds.get(String(i))?.category !== b.expected)
    .map((b) => `${b.expected.padEnd(13)} <- got ${String(preds.get(String(BENCHMARK.indexOf(b)))?.category).padEnd(13)} | ${b.description.slice(0, 70)}`);
  return { accuracy: (BENCHMARK.length - misses.length) / BENCHMARK.length, misses };
}

describe("categorizer benchmark", () => {
  it("rules-only accuracy does not regress", async () => {
    const { accuracy, misses } = await benchmarkAccuracy();
    console.log(`rules-only benchmark accuracy: ${(accuracy * 100).toFixed(1)}% (${BENCHMARK.length} cases)\n` + misses.join("\n"));
    expect(accuracy).toBeGreaterThanOrEqual(BASELINE);
  });
});

// Raise this when the rules improve. Never lower it without a reason in the commit message.
const BASELINE = 0.925;
