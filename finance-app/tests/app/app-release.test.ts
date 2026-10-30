import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as apk } from "@/app/api/v1/app/apk/route";
import { GET as latest } from "@/app/api/v1/app/latest/route";
import { loadReadyRelease, parsePubspecVersion, parseReleaseManifest, publishRelease } from "@/core/app-release";
import { issueSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { resetRateLimits } from "@/lib/rate-limit";

const BYTES = Buffer.from("synthetic-apk-not-a-real-package");
const SHA = createHash("sha256").update(BYTES).digest("hex");

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, { headers });
}

describe("self-hosted app release", () => {
  let dir: string;
  let token: string;
  const previous = process.env.APP_RELEASE_DIR;

  beforeAll(async () => {
    resetRateLimits();
    dir = await mkdtemp(join(tmpdir(), "ledger-release-"));
    process.env.APP_RELEASE_DIR = dir;
    const user = await db.user.create({ data: { email: "app-release@test.dev" } });
    token = (await issueSession(user.id)).token;
    const source = join(dir, "built.apk");
    await writeFile(source, BYTES);
    publishRelease({ apkPath: source, dir, version: "0.3.3", buildNumber: 6 });
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.APP_RELEASE_DIR;
    else process.env.APP_RELEASE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });

  it("reads pubspec versions and rejects a manifest that does not match the file", () => {
    expect(parsePubspecVersion("name: ledger_mobile\nversion: 0.3.3+6\n")).toEqual({ version: "0.3.3", buildNumber: 6 });
    expect(parsePubspecVersion("version: 0.3.3\n")).toBeNull();
    expect(parseReleaseManifest({ version: "0.3.3", buildNumber: 6, sha256: SHA, size: BYTES.length })?.buildNumber).toBe(6);
    expect(parseReleaseManifest({ version: "0.3.3", buildNumber: "6", sha256: SHA, size: BYTES.length })).toBeNull();
    expect(parseReleaseManifest({ version: "0.3.3", buildNumber: 6, sha256: "abcd", size: BYTES.length })).toBeNull();
  });

  it("requires a session token and returns the published manifest", async () => {
    const denied = await latest(get("/api/v1/app/latest"));
    expect(denied.status).toBe(401);

    const sms = await latest(get("/api/v1/app/latest", { "x-ledger-sms-token": "smsTok1234567890ab" }));
    expect(sms.status).toBe(401);

    const res = await latest(get("/api/v1/app/latest", { authorization: `Bearer ${token}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "0.3.3", buildNumber: 6, sha256: SHA, size: BYTES.length });
  });

  it("streams the APK bytes and hides a release whose hash does not match", async () => {
    const res = await apk(get("/api/v1/app/apk", { authorization: `Bearer ${token}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true);

    const manifestPath = join(dir, "latest.json");
    const broken = JSON.parse(await readFile(manifestPath, "utf8")) as { sha256: string };
    broken.sha256 = "a".repeat(64);
    await writeFile(manifestPath, JSON.stringify(broken));
    expect(loadReadyRelease(dir)).toBeNull();
    const hidden = await latest(get("/api/v1/app/latest", { authorization: `Bearer ${token}` }));
    expect(hidden.status).toBe(404);
    const hiddenApk = await apk(get("/api/v1/app/apk", { authorization: `Bearer ${token}` }));
    expect(hiddenApk.status).toBe(404);
  });
});
