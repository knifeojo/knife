import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { loadReadyRelease } from "@/core/app-release";
import { apiError, clientIp, requireApiUser } from "@/lib/mobile/http";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Streams latest.apk after the manifest hash and size match the file. Session bearer only. */
export async function GET(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;
  const limited = rateLimit(`app-apk:${auth.user.id}:${clientIp(req)}`, 10, 60_000);
  if (!limited.allowed) return apiError(429, "Too many update downloads; try again shortly.");
  const ready = loadReadyRelease();
  if (!ready) return apiError(404, "No app release yet");
  const stream = Readable.toWeb(createReadStream(ready.apkPath)) as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": String(ready.release.size),
      "Content-Disposition": 'attachment; filename="ledger.apk"',
      "X-Content-Type-Options": "nosniff",
    },
  });
}
