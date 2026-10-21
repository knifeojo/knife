import { beforeEach, describe, expect, it } from "vitest";
import { rateLimit, resetRateLimits } from "@/lib/rate-limit";

beforeEach(() => resetRateLimits());

describe("rateLimit", () => {
  it("allows the first calls in a window and then blocks", () => {
    expect(rateLimit("login:test", 2, 60_000).allowed).toBe(true);
    expect(rateLimit("login:test", 2, 60_000).allowed).toBe(true);
    const blocked = rateLimit("login:test", 2, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("keeps separate keys apart", () => {
    rateLimit("a", 1, 60_000);
    expect(rateLimit("b", 1, 60_000).allowed).toBe(true);
    expect(rateLimit("a", 1, 60_000).allowed).toBe(false);
  });
});
