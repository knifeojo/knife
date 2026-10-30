import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appReleaseDir, parsePubspecVersion, publishRelease } from "../core/app-release";
import { loadDotEnv } from "./dotenv";

// Builds the sideload debug APK and publishes it for GET /api/v1/app/latest.
// Usage (from finance-app): npm run app:release
// Writes ~/ledger-private/releases/latest.apk and latest.json, or APP_RELEASE_DIR.

function main() {
  loadDotEnv();
  const mobile = resolve(process.cwd(), "../ledger_mobile");
  const pubspecPath = resolve(mobile, "pubspec.yaml");
  let pubspec: string;
  try {
    pubspec = readFileSync(pubspecPath, "utf8");
  } catch {
    throw new Error("Run this from finance-app so ../ledger_mobile/pubspec.yaml is readable.");
  }
  const parsed = parsePubspecVersion(pubspec);
  if (!parsed) throw new Error("ledger_mobile/pubspec.yaml needs version: 0.3.3+6");

  const flutter = process.env.FLUTTER_BIN || "flutter";
  const built = spawnSync(flutter, ["build", "apk", "--debug"], { cwd: mobile, stdio: "inherit" });
  if (built.error) throw new Error(`Could not run ${flutter}. Install Flutter or set FLUTTER_BIN.`);
  if (built.status !== 0) process.exit(built.status ?? 1);

  const apkPath = resolve(mobile, "build/app/outputs/flutter-apk/app-debug.apk");
  const dir = appReleaseDir();
  const release = publishRelease({ apkPath, dir, version: parsed.version, buildNumber: parsed.buildNumber });
  console.log(`Published ${release.version}+${release.buildNumber} (${release.size} bytes) to ${dir}`);
  console.log(`sha256 ${release.sha256}`);
}

try {
  main();
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : "release failed");
  process.exit(1);
}
