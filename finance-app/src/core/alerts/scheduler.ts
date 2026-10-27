import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { syncEmailSource } from "../ledger";
import { GmailEmailSource } from "../providers/gmail";
import { ImapEmailSource } from "./imap";
import { defaultSyncMinutes } from "./secrets";

export function connectionDue(
  conn: { lastSyncedAt: Date | null; nextRetryAt: Date | null; syncIntervalMinutes: number | null; status: string },
  now = new Date(),
  defaultMinutes = defaultSyncMinutes(),
): boolean {
  if (conn.status !== "active") return false;
  if (conn.nextRetryAt && conn.nextRetryAt.getTime() <= now.getTime()) return true;
  const interval = (conn.syncIntervalMinutes ?? defaultMinutes) * 60_000;
  if (!conn.lastSyncedAt) return true;
  return now.getTime() - conn.lastSyncedAt.getTime() >= interval;
}

export function nextBackoffMs(prev = 0): number {
  const base = prev > 0 ? prev * 2 : 30_000;
  return Math.min(base, 30 * 60_000);
}

export async function syncOneConnection(connectionId: string): Promise<void> {
  const conn = await db.financialConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const running = await db.syncRun.findFirst({
    where: { connectionId, status: "running", startedAt: { gte: new Date(Date.now() - 10 * 60_000) } },
  });
  if (running) return;

  if (conn.provider === "gmail") {
    await syncEmailSource(conn.userId, conn.id, new GmailEmailSource(conn.id));
    return;
  }
  if (conn.provider === "imap") {
    await syncEmailSource(conn.userId, conn.id, ImapEmailSource.fromConnection(conn));
    return;
  }
}

export async function syncDueConnections(now = new Date()): Promise<{ attempted: number; ok: number; failed: number }> {
  const conns = await db.financialConnection.findMany({
    where: { status: "active", provider: { in: ["gmail", "imap"] } },
  });
  const due = conns.filter((c) => connectionDue(c, now));
  let ok = 0;
  let failed = 0;
  for (const conn of due) {
    try {
      await syncOneConnection(conn.id);
      await db.financialConnection.update({ where: { id: conn.id }, data: { backoffMs: 0, nextRetryAt: null } });
      ok++;
    } catch (e) {
      const backoff = nextBackoffMs(conn.backoffMs);
      await db.financialConnection.update({
        where: { id: conn.id },
        data: { backoffMs: backoff, nextRetryAt: new Date(now.getTime() + backoff), lastError: e instanceof Error ? e.message.slice(0, 300) : "sync failed" },
      });
      log.error("alert_sync.failed", { connectionId: conn.id, error: e instanceof Error ? e.message : "unknown" });
      failed++;
    }
  }
  return { attempted: due.length, ok, failed };
}

let timer: ReturnType<typeof setInterval> | undefined;

export function startAlertSyncLoop(): void {
  if (process.env.ALERT_SYNC === "0" || process.env.NODE_ENV === "test") return;
  if (timer) return;
  const minutes = defaultSyncMinutes();
  const tick = () => {
    syncDueConnections().catch((e) => log.error("alert_sync.tick_failed", { error: e instanceof Error ? e.message : "unknown" }));
  };
  timer = setInterval(tick, minutes * 60_000);
  setTimeout(tick, 15_000);
}

export function stopAlertSyncLoop(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
