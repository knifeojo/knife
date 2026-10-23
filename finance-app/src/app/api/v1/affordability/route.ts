import { db } from "@/lib/db";
import { MAX_AMOUNT_MINOR, affordabilityJson, checkAffordability, cleanDescription, parseHorizon } from "@/core/affordability";
import { apiError, apiJson, readJsonObject, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MINOR = /^\d{1,16}$/;

/** POST { amountMinor: "250000000", description?, horizon?: "month_end" | 1..120 days, bufferMinor? } */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const { amountMinor, description, horizon, bufferMinor } = parsed.body;

  if (typeof amountMinor !== "string" || !MINOR.test(amountMinor) || BigInt(amountMinor) <= 0n || BigInt(amountMinor) > MAX_AMOUNT_MINOR) {
    return apiError(400, "amountMinor must be a positive whole number of kobo, sent as a string");
  }
  const window = parseHorizon(horizon);
  if (!window) return apiError(400, "horizon must be \"month_end\" or a number of days from 1 to 120");
  if (bufferMinor !== undefined && bufferMinor !== null && (typeof bufferMinor !== "string" || !MINOR.test(bufferMinor))) {
    return apiError(400, "bufferMinor must be a whole number of kobo, sent as a string");
  }
  if ((await db.transaction.count({ where: { userId: auth.user.id } })) === 0) {
    return apiError(409, "Import a statement first so Ledger has your income and spending to go on.");
  }

  const result = await checkAffordability(auth.user.id, {
    amountMinor: BigInt(amountMinor),
    description: cleanDescription(description),
    horizon: window,
    bufferMinor: typeof bufferMinor === "string" ? BigInt(bufferMinor) : undefined,
  });
  return apiJson(affordabilityJson(result));
}
