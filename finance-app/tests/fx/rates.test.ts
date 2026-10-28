import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { conversionLabel, convertToNgn, loadFxContext, REALISED_WINDOW_DAYS } from "@/core/fx/rates";
import { setManualRate } from "@/core/fx/provider";

let n = 0;
async function user(preference: "official" | "street" = "official") {
  return db.user.create({ data: { email: `fx-rate-${++n}@test.dev`, fxNgnPreference: preference } });
}

async function rate(data: { userId?: string; date: string; base: string; quote?: string; rate: number; source: string }) {
  const row = { userId: data.userId ?? "", date: data.date, base: data.base, quote: data.quote ?? "NGN", rate: data.rate, source: data.source };
  return db.fxRate.upsert({
    where: { userId_date_base_quote_source: { userId: row.userId, date: row.date, base: row.base, quote: row.quote, source: row.source } },
    create: row,
    update: { rate: row.rate },
  });
}

describe("FX precedence", () => {
  it("uses a realised rate within 7 days ahead of market and manual", async () => {
    const u = await user("street");
    await rate({ userId: u.id, date: "2026-09-24", base: "USD", rate: 1550, source: "realised" });
    await rate({ date: "2026-09-20", base: "USD", rate: 1500, source: "market" });
    await setManualRate(u.id, "USD", "NGN", 2000, "2026-09-01");
    const ctx = await loadFxContext(u.id);
    const hit = convertToNgn(ctx, 100_00n, "USD", new Date("2026-09-26T12:00:00Z"));
    expect(hit).toMatchObject({ rate: 1550, source: "realised", rateDate: "2026-09-24" });
    expect(hit!.nairaMinor).toBe(155_000_00n);
    expect(conversionLabel(hit!, "USD")).toBe("converted at ₦1,550.00 per $ (realised) on 24 Sep 2026");
  });

  it("manual street override beats market, but not a nearby realised rate", async () => {
    const u = await user("street");
    await rate({ userId: u.id, date: "2026-09-01", base: "USD", rate: 1550, source: "realised" });
    await rate({ date: "2026-09-20", base: "USD", rate: 1500, source: "market" });
    await setManualRate(u.id, "USD", "NGN", 2000, "2026-09-10");
    const ctx = await loadFxContext(u.id);
    const far = convertToNgn(ctx, 100_00n, "USD", new Date("2026-09-20T12:00:00Z"));
    expect(far).toMatchObject({ rate: 2000, source: "manual" });
    const near = convertToNgn(ctx, 100_00n, "USD", new Date("2026-09-04T12:00:00Z"));
    expect(near).toMatchObject({ rate: 1550, source: "realised" });
  });

  it("official preference uses market over manual when realised is outside the window", async () => {
    const u = await user("official");
    await rate({ userId: u.id, date: "2026-09-01", base: "USD", rate: 1550, source: "realised" });
    await rate({ date: "2026-09-20", base: "USD", rate: 1500, source: "market" });
    await setManualRate(u.id, "USD", "NGN", 2000, "2026-09-10");
    const ctx = await loadFxContext(u.id);
    const hit = convertToNgn(ctx, 50_00n, "USD", new Date("2026-09-20T12:00:00Z"));
    expect(hit).toMatchObject({ rate: 1500, source: "market", rateDate: "2026-09-20" });
    expect(conversionLabel(hit!, "USD")).toMatch(/\(market\) on 20 Sep 2026/);
  });

  it("falls back to the latest realised rate within 30 days when there is no market for that currency", async () => {
    const u = await user();
    await rate({ date: "2026-09-20", base: "USD", rate: 1500, source: "market" });
    await rate({ userId: u.id, date: "2026-09-28", base: "CAD", rate: 964.19, source: "realised" });
    const ctx = await loadFxContext(u.id);
    const hit = convertToNgn(ctx, 6000_00n, "CAD", new Date("2026-09-01T12:00:00Z"));
    expect(hit).toMatchObject({ rate: 964.19, source: "realised" });
    expect(Number(hit!.nairaMinor) / 100).toBeCloseTo(6000 * 964.19, -1);
  });

  it("does not use a realised rate more than 30 days away", async () => {
    const u = await user();
    await rate({ date: "2026-09-20", base: "USD", rate: 1500, source: "market" });
    await rate({ userId: u.id, date: "2026-07-01", base: "CAD", rate: 964.19, source: "realised" });
    const ctx = await loadFxContext(u.id);
    expect(convertToNgn(ctx, 100_00n, "CAD", new Date("2026-09-20T12:00:00Z"))).toBeNull();
  });

  it("auto-seeds bundled market rates when none exist", async () => {
    const u = await user();
    const ctx = await loadFxContext(u.id);
    expect(ctx.market.length).toBeGreaterThan(0);
    const hit = convertToNgn(ctx, 100_00n, "USD", new Date("2026-09-01T12:00:00Z"));
    expect(hit?.rate).toBe(1540);
  });

  it("does not treat a realised rate more than 7 days away as nearby", async () => {
    expect(REALISED_WINDOW_DAYS).toBe(7);
    const u = await user("official");
    await rate({ userId: u.id, date: "2026-09-01", base: "USD", rate: 1400, source: "realised" });
    await rate({ date: "2026-09-20", base: "USD", rate: 1500, source: "market" });
    const ctx = await loadFxContext(u.id);
    const hit = convertToNgn(ctx, 100_00n, "USD", new Date("2026-09-20T12:00:00Z"));
    expect(hit).toMatchObject({ rate: 1500, source: "market" });
  });

  it("marks a seed from months earlier as approximate", async () => {
    const u = await user("official");
    await rate({ date: "2025-06-01", base: "USD", rate: 1480, source: "seed" });
    const ctx = await loadFxContext(u.id);
    const hit = convertToNgn(ctx, 100_00n, "USD", new Date("2025-08-15T12:00:00Z"));
    expect(hit).toMatchObject({ rate: 1480, source: "approximate", rateDate: "2025-06-01" });
    expect(conversionLabel(hit!, "USD")).toMatch(/\(approximate\) on 1 Jun 2025/);
  });

  it("leaves naira amounts unconverted", async () => {
    const u = await user();
    const ctx = await loadFxContext(u.id);
    expect(convertToNgn(ctx, 50_000_00n, "NGN", new Date("2026-09-15T12:00:00Z"))).toMatchObject({
      nairaMinor: 50_000_00n, rate: 1, source: "market",
    });
  });
});
