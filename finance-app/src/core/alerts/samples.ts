import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Unparsed / low-confidence samples stay on this machine for future parser work.
// Never written into the repo. Tests skip unless ALERT_SAMPLE_DIR is set.

export function sampleDir(): string | undefined {
  if (process.env.NODE_ENV === "test" && !process.env.ALERT_SAMPLE_DIR) return undefined;
  return process.env.ALERT_SAMPLE_DIR ?? join(homedir(), ".ledger", "alert-samples");
}

export function storeAlertSample(meta: { userId: string; channel: string; sender: string; parser?: string; body: string }): void {
  const dir = sampleDir();
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = `${stamp}-${meta.channel}-${meta.sender.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24)}.txt`;
    writeFileSync(join(dir, name), `sender=${meta.sender}\nchannel=${meta.channel}\nparser=${meta.parser ?? ""}\n\n${meta.body}`, { mode: 0o600 });
  } catch {
    // Local disk is best-effort. The UnparsedAlert row is the source of truth.
  }
}
