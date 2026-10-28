import { describe, expect, it } from "vitest";
import { extractPayoutQuote } from "@/core/fx/quotes";

describe("extractPayoutQuote", () => {
  it("reads an explicit @ / at / rate figure", () => {
    expect(extractPayoutQuote("USD wallet payout @ 1550 NGN", 100_00n)).toEqual({
      ngnMinor: 155_000_00n,
      rate: 1550,
    });
    expect(extractPayoutQuote("Payout at rate: 1,550", 80_00n)?.rate).toBe(1550);
    expect(extractPayoutQuote("1550 NGN / USD", 40_00n)?.rate).toBe(1550);
  });

  it("reads stated NGN proceeds and skips account numbers", () => {
    expect(extractPayoutQuote("Payout NGN 155,000.00 to GTBank", 100_00n)).toEqual({
      ngnMinor: 155_000_00n,
      rate: 1550,
    });
    expect(extractPayoutQuote("Money transfer to ADA EZE / 0001234533 / Guaranty Trust Bank", 100_00n)).toBeNull();
  });
});
