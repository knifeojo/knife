import { describe, expect, it, vi } from "vitest";
import { withBusyRetry } from "@/lib/db";

describe("SQLite busy retry", () => {
  it("retries SQLITE_BUSY and then succeeds", async () => {
    let n = 0;
    const result = await withBusyRetry(async () => {
      n++;
      if (n < 3) throw new Error("SQLITE_BUSY: database is locked");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(n).toBe(3);
  });

  it("does not retry a unique constraint", async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    });
    await expect(withBusyRetry(fn, 4)).rejects.toMatchObject({ code: "P2002" });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
