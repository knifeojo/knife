import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { gmailFilterXml } from "@/core/alerts/filters";
import { ensureUserTokens, inboundAddress } from "@/core/alerts/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  const tokens = await ensureUserTokens(user.id);
  const address = inboundAddress(tokens.inboundEmailToken);
  if (!address) return NextResponse.redirect("/app/settings");
  const xml = gmailFilterXml({ forwardTo: address });
  return new NextResponse(xml, {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ledger-bank-filters.xml"',
      "Cache-Control": "no-store",
    },
  });
}
