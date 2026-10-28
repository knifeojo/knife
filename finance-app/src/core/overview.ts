import { incomeSources, previousCalendarMonth, spendingByCategory, summary, type Period } from "./analytics";
import { loadCadence, spendingSplit } from "./cadence";

/**
 * Home payload for one Lagos month. In/out/left reuse `summary` so they match GET /summary
 * (own transfers, paired legs, reversals, fee credits, FX to naira).
 */
export async function monthOverview(userId: string, period: Period) {
  const prev = previousCalendarMonth(period);
  const [figures, prevFigures, categories, sources, cadence] = await Promise.all([
    summary(userId, period),
    summary(userId, prev),
    spendingByCategory(userId, period),
    incomeSources(userId, period, 5),
    loadCadence(userId),
  ]);
  const split = await spendingSplit(userId, period, cadence);
  const reviewCount = split.unlabelled.needsReview ? split.unlabelled.count : 0;
  return { figures, prevOut: prevFigures.expenses, categories, sources, reviewCount, period, prev };
}
