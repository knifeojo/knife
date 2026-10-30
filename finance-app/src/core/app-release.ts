import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const RELEASE_APK = "latest.apk";
export const RELEASE_MANIFEST = "latest.json";

export interface AppRelease {
  version: string;
  buildNumber: number;
  sha256: string;
  size: number;
}

/** Directory that holds latest.apk and latest.json. `~/...` is the server user's home. */
export function appReleaseDir(env = process.env, home = homedir()): string {
  const raw = (env.APP_RELEASE_DIR ?? "").trim();
  const chosen = raw.length === 0 ? join(home, "ledger-private", "releases") : raw;
  const expanded = chosen === "~" ? home : chosen.startsWith("~/") ? join(home, chosen.slice(2)) : chosen;
  return resolve(expanded);
}

export function releasePaths(dir: string) {
  return { apk: join(dir, RELEASE_APK), manifest: join(dir, RELEASE_MANIFEST) };
}

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{64}$/;

export function parsePubspecVersion(text: string): { version: string; buildNumber: number } | null {
  const match = /^version:\s*(\d+\.\d+\.\d+)\+(\d+)\s*$/m.exec(text);
  if (!match) return null;
  const buildNumber = Number(match[2]);
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) return null;
  return { version: match[1], buildNumber };
}

export function parseReleaseManifest(raw: unknown): AppRelease | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const version = body.version;
  const buildNumber = body.buildNumber;
  const sha256 = body.sha256;
  const size = body.size;
  if (typeof version !== "string" || !VERSION.test(version)) return null;
  if (typeof buildNumber !== "number" || !Number.isSafeInteger(buildNumber) || buildNumber < 1) return null;
  if (typeof sha256 !== "string" || !SHA.test(sha256.toLowerCase())) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) return null;
  return { version, buildNumber, sha256: sha256.toLowerCase(), size };
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Copy an APK into the release directory and write latest.json from its bytes. */
export function publishRelease(opts: { apkPath: string; dir: string; version: string; buildNumber: number }): AppRelease {
  if (!VERSION.test(opts.version) || !Number.isSafeInteger(opts.buildNumber) || opts.buildNumber < 1) {
    throw new Error("version must look like 0.3.3+6");
  }
  mkdirSync(opts.dir, { recursive: true });
  const { apk, manifest } = releasePaths(opts.dir);
  copyFileSync(opts.apkPath, apk);
  const size = statSync(apk).size;
  const release: AppRelease = {
    version: opts.version,
    buildNumber: opts.buildNumber,
    sha256: sha256File(apk),
    size,
  };
  writeFileSync(manifest, `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

/**
 * The manifest and the APK agree. A missing file, a bad manifest, or a hash/size mismatch
 * is "no release" so the phone never downloads a package we would not install.
 */
export function loadReadyRelease(dir = appReleaseDir()): { release: AppRelease; apkPath: string } | null {
  const { apk, manifest } = releasePaths(dir);
  let parsed: AppRelease | null;
  try {
    parsed = parseReleaseManifest(JSON.parse(readFileSync(manifest, "utf8")) as unknown);
  } catch {
    return null;
  }
  if (!parsed) return null;
  let size: number;
  try {
    size = statSync(apk).size;
  } catch {
    return null;
  }
  if (size !== parsed.size) return null;
  if (sha256File(apk) !== parsed.sha256) return null;
  return { release: parsed, apkPath: apk };
}
