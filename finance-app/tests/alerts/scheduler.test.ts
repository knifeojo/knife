import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionDue, nextBackoffMs } from "@/core/alerts/scheduler";

describe("alert sync scheduling", () => {
  afterEach(() => vi.useRealTimers());

  it("is due when never synced or the interval has elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const now = new Date();
    expect(connectionDue({ lastSyncedAt: null, nextRetryAt: null, syncIntervalMinutes: null, status: "active" }, now, 5)).toBe(true);
    expect(connectionDue({ lastSyncedAt: new Date("2026-10-03T11:56:00Z"), nextRetryAt: null, syncIntervalMinutes: null, status: "active" }, now, 5)).toBe(false);
    expect(connectionDue({ lastSyncedAt: new Date("2026-10-03T11:54:00Z"), nextRetryAt: null, syncIntervalMinutes: null, status: "active" }, now, 5)).toBe(true);
    expect(connectionDue({ lastSyncedAt: new Date("2026-10-03T11:59:00Z"), nextRetryAt: new Date("2026-10-03T11:59:00Z"), syncIntervalMinutes: 30, status: "active" }, now, 5)).toBe(true);
    expect(connectionDue({ lastSyncedAt: null, nextRetryAt: null, syncIntervalMinutes: null, status: "error" }, now, 5)).toBe(false);
  });

  it("backs off exponentially and caps at 30 minutes", () => {
    expect(nextBackoffMs(0)).toBe(30_000);
    expect(nextBackoffMs(30_000)).toBe(60_000);
    expect(nextBackoffMs(20 * 60_000)).toBe(30 * 60_000);
  });
});
