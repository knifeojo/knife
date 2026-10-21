import { apiJson } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The phone calls this before saving a server URL. No secrets, no auth. */
export async function GET() {
  return apiJson({ ok: true, service: "ledger", version: 1 });
}
