import { describe, expect, it } from "vitest";
import { formatMixedTotal, formatMoney, formatMoneyParts } from "@/lib/money";

describe("money display uses the transaction currency", () => {
  it("formats GHS, CAD, GBP, USD, KES and XOF with their own symbols, not naira", () => {
    expect(formatMoney(1197_60n, "USD")).toBe("$1,197.60");
    expect(formatMoney(812n, "CAD")).toBe("CA$8.12");
    expect(formatMoney(435n, "GBP")).toBe("£4.35");
    expect(formatMoney(2500_00n, "GHS")).toBe("₵2,500.00");
    expect(formatMoney(100_00n, "KES")).toBe("KSh100.00");
    expect(formatMoney(5000_00n, "XOF")).toBe("CFA5,000.00");
    expect(formatMoney(50_000_00n, "NGN")).toBe("₦50,000.00");
  });

  it("never sums mixed currencies into one raw figure", () => {
    const parts = formatMoneyParts([
      { currency: "USD", minor: 1197_60n },
      { currency: "NGN", minor: 50_000_00n },
    ]);
    expect(parts).toBe("$1,197.60 + ₦50,000.00");
    const mixed = formatMixedTotal(
      [{ currency: "USD", minor: 1197_60n }, { currency: "NGN", minor: 50_000_00n }],
      2_055_280_00n,
    );
    expect(mixed.display).toBe("₦2,055,280.00");
    expect(mixed.detail).toBe("$1,197.60 + ₦50,000.00");
    expect(mixed.currency).toBe("NGN");
  });

  it("a single-currency group stays in that currency", () => {
    const one = formatMixedTotal([{ currency: "USD", minor: 40_00n }], 62_000_00n);
    expect(one.display).toBe("$40.00");
    expect(one.detail).toBeNull();
    expect(one.currency).toBe("USD");
  });
});
