import { NextResponse } from "next/server";
import { requireApiUser, apiError } from "@/lib/mobile/http";
import { gmailFilterXml } from "@/core/alerts/filters";
import { ensureUserTokens, inboundAddress } from "@/core/alerts/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const tokens = await ensureUserTokens(auth.user.id);
  const address = inboundAddress(tokens.inboundEmailToken);
  if (!address) return apiError(400, "Set INBOUND_EMAIL_DOMAIN to download filters.");
  const xml = gmailFilterXml({ forwardTo: address });
  return new NextResponse(xml, {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ledger-bank-filters.xml"',
      "Cache-Control": "no-store",
    },
  });
}
