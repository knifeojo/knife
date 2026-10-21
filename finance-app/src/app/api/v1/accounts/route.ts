import { balances } from "@/core/analytics";
import { apiJson, requireApiUser } from "@/lib/mobile/http";
import { accountJson, minor } from "@/lib/mobile/serialize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const { accounts, totalBase } = await balances(auth.user.id);
  return apiJson({
    accounts: accounts.map(accountJson),
    // Naira only. Foreign balances stay on each account until a rate is learned.
    totalBaseMinor: minor(totalBase),
    totalBaseCurrency: "NGN",
  });
}
