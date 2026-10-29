import { incomeSources, previousCalendarMonth, spendingByCategory, summary, type Period } from "./analytics";
import { pendingReviewCount } from "./review";

/**
 * Home payload for one Lagos month. In/out/left reuse `summary` so they match GET /summary
 * (own transfers, paired legs, reversals, fee credits, FX to naira).
 * reviewCount is the pending Review total (questions plus open held/unparsed alerts), same as the web nav badge.
 */
export async function monthOverview(userId: string, period: Period) {
  const prev = previousCalendarMonth(period);
  const [figures, prevFigures, categories, sources, reviewCount] = await Promise.all([
    summary(userId, period),
    summary(userId, prev),
    spendingByCategory(userId, period),
    incomeSources(userId, period, 5),
    pendingReviewCount(userId),
  ]);
  return { figures, prevOut: prevFigures.expenses, categories, sources, reviewCount, period, prev };
}
