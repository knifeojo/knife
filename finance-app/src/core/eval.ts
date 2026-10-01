import { db } from "@/lib/db";
import { OWN_TRANSFER, categorize, type UserRule } from "./categorize";
import { loadOwners } from "./ledger";
import type { Classification, TransactionType } from "./types";

// Accuracy scorecard. Ground truth = categories the user set (answers and corrections).
// We ask: "had the user never answered, would the automatic categorizer have got it right?"
// So user rules are NOT given to the classifier under test (that would be grading its own homework).

export type Classifier = (rows: { id: string; description: string; type: TransactionType }[], owners: string[]) => Promise<Map<string, Classification>>;

export const rulesClassifier: Classifier = async (rows, owners) =>
  new Map(rows.map((r) => [r.id, categorize({ description: r.description, type: r.type }, [] as UserRule[], owners)]));

const GENERIC = new Set(["Transfers", "Other"]);

export interface Scorecard {
  method: string;
  labelled: number;
  correct: number;
  accuracy: number; // by count
  valueAccuracy: number; // by naira value
  coverage: number; // share of spending in a specific category right now
  mistakes: { description: string; expected: string; got: string; amountMinor: bigint }[];
}

export async function scoreUser(userId: string, classifier: Classifier = rulesClassifier, method = "rules", save = true): Promise<Scorecard> {
  const owners = await loadOwners(userId);
  const labelled = await db.transaction.findMany({
    where: { userId, classificationSource: "user" },
    select: { id: true, description: true, type: true, category: true, amountMinor: true },
  });
  const preds = await classifier(labelled.map((r) => ({ id: r.id, description: r.description, type: r.type as TransactionType })), owners);
  let correct = 0;
  let correctMinor = 0n;
  let labelledMinor = 0n;
  const mistakes: Scorecard["mistakes"] = [];
  for (const r of labelled) {
    labelledMinor += r.amountMinor;
    const got = preds.get(r.id)?.category;
    if (got === r.category) {
      correct++;
      correctMinor += r.amountMinor;
    } else mistakes.push({ description: r.description, expected: r.category, got: got ?? "(none)", amountMinor: r.amountMinor });
  }
  const spend = await db.transaction.groupBy({
    by: ["category"],
    where: { userId, type: "DEBIT", category: { not: OWN_TRANSFER }, transferPairId: null },
    _sum: { amountMinor: true },
  });
  const total = spend.reduce((s, x) => s + (x._sum.amountMinor ?? 0n), 0n);
  const specific = spend.filter((x) => !GENERIC.has(x.category)).reduce((s, x) => s + (x._sum.amountMinor ?? 0n), 0n);
  const coverage = total > 0n ? Number((specific * 10000n) / total) / 10000 : 0;
  const card: Scorecard = {
    method,
    labelled: labelled.length,
    correct,
    accuracy: labelled.length ? correct / labelled.length : 0,
    valueAccuracy: labelledMinor > 0n ? Number((correctMinor * 10000n) / labelledMinor) / 10000 : 0,
    coverage,
    mistakes: mistakes.sort((a, b) => (b.amountMinor > a.amountMinor ? 1 : -1)).slice(0, 10),
  };
  if (save) {
    await db.evalRun.create({ data: { userId, method, labelled: card.labelled, correct, labelledMinor, correctMinor, coverage } });
  }
  return card;
}

export async function scoreHistory(userId: string, take = 10) {
  return db.evalRun.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take });
}
