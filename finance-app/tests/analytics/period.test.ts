import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  calendarYearPeriod, lastNMonthsPeriod, monthsInPeriod, savingsRate, summary, ytdPeriod,
} from "@/core/analytics";
import { resolveViewPeriod } from "@/components/period-switcher";

let n = 0;

describe("multi-month periods", () => {
  it("builds 3-month, YTD and calendar-year spans in Lagos time", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const three = lastNMonthsPeriod(now, 3);
    expect(three.label).toBe("Last 3 months");
    expect(monthsInPeriod(three).map((m) => m.label)).toEqual(["August 2026", "September 2026", "October 2026"]);
    expect(ytdPeriod(now).label).toBe("Year to date 2026");
    expect(monthsInPeriod(ytdPeriod(now))).toHaveLength(10);
    expect(monthsInPeriod(calendarYearPeriod(2026))).toHaveLength(12);
    expect(calendarYearPeriod(2026).label).toBe("2026");
  });

  it("savings rate is net over income, and null with no income", () => {
    expect(savingsRate(100_00n, 40_00n)).toBeCloseTo(0.6);
    expect(savingsRate(0n, 40_00n)).toBeNull();
  });

  it("resolves query params and totals across a year", async () => {
    const u = await db.user.create({ data: { email: `period-${++n}@test.dev` } });
    const acct = await db.account.create({
      data: { userId: u.id, institution: "GTBank", accountName: "GTB", maskedAccountNumber: "****4444", currency: "NGN" },
    });
    const add = async (date: string, type: "DEBIT" | "CREDIT", amount: bigint, category: string) => {
      await db.transaction.create({
        data: {
          userId: u.id, accountId: acct.id, source: "fixture",
          sourceTransactionId: `p-${++n}`, fingerprint: `fp-p-${++n}`,
          transactionDate: new Date(`${date}T12:00:00Z`), type, amountMinor: amount, currency: "NGN",
          description: category, category, classificationSource: "rule", classificationConfidence: 0.9,
        },
      });
    };
    await add("2026-03-10", "CREDIT", 100_000_00n, "Income");
    await add("2026-03-12", "DEBIT", 40_000_00n, "Food");
    await add("2026-09-10", "CREDIT", 80_000_00n, "Income");
    await add("2026-09-12", "DEBIT", 20_000_00n, "Food");
    const year = await resolveViewPeriod(u.id, { p: "year", y: "2026" }, new Date("2026-10-27T12:00:00Z"));
    expect(year.kind).toBe("year");
    expect(year.period.label).toBe("2026");
    const s = await summary(u.id, year.period);
    expect(s.income).toBe(180_000_00n);
    expect(s.expenses).toBe(60_000_00n);
    expect(s.savingsRate).toBeCloseTo(120_000 / 180_000);
    const three = await resolveViewPeriod(u.id, { p: "3m" }, new Date("2026-10-27T12:00:00Z"));
    const t = await summary(u.id, three.period);
    expect(t.income).toBe(80_000_00n);
    expect(t.expenses).toBe(20_000_00n);
  });
});
