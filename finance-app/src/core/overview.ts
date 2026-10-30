import { incomeSources, previousCalendarMonth, spendingByCategory, summary, type Period } from "./analytics";
import { freedThrough, loanClearedCards, syncLoanMoments } from "./loan-moments";
import { pendingReviewCount } from "./review";

/**
 * Home payload for one Lagos month. In/out/left reuse `summary` so they match GET /summary
 * (own transfers, paired legs, reversals, fee credits, FX to naira).
 * reviewCount is the pending Review question total, same as the web nav badge.
 */
export async function monthOverview(userId: string, period: Period) {
  await syncLoanMoments(userId);
  const prev = previousCalendarMonth(period);
  const [figures, prevFigures, categories, sources, reviewCount, cleared, freed] = await Promise.all([
    summary(userId, period),
    summary(userId, prev),
    spendingByCategory(userId, period),
    incomeSources(userId, period, 5),
    pendingReviewCount(userId),
    loanClearedCards(userId),
    freedThrough(userId, period.to),
  ]);
  const current = period.from.getTime() <= Date.now() && Date.now() < period.to.getTime();
  return { figures, prevOut: prevFigures.expenses, categories, sources, reviewCount, period, prev, cleared, freed: current ? freed : 0n };
}
