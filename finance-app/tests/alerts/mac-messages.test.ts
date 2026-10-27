import { describe, expect, it } from "vitest";
import { appleDate, attributedBodyText, bankMessagesFromChatRows } from "@/core/alerts/mac-messages";

describe("macOS Messages importer", () => {
  it("converts Apple epoch nanoseconds", () => {
    const d = appleDate(BigInt(812_505_000_000_000_000)); // ~2026-10-03-ish; just assert finite
    expect(d.getTime()).not.toBeNaN();
    expect(appleDate(0).toISOString()).toBe("2001-01-01T00:00:00.000Z");
  });

  it("reads attributedBody when text is null and ignores non-bank senders", () => {
    const blob = Buffer.from(`xxxxNSString+++Acct:******1234 Amt:NGN3,450.00 DR Desc:OUTWARD TRANSFER Bal:NGN2.00 Date:2026-10-07 3:17PM+++NSDictionary`, "utf8");
    expect(attributedBodyText(blob)).toMatch(/Acct:\*{6}1234/);
    const rows = bankMessagesFromChatRows([
      { id: 1, sender: "GTBank", text: null, attributedBody: blob, date: 0 },
      { id: 2, sender: "+2348011111111", text: "hey mum", attributedBody: null, date: 0 },
      { id: 3, sender: "GloDataSale", text: "Buy data", attributedBody: null, date: 0 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].sender).toBe("GTBank");
    expect(rows[0].text).toMatch(/OUTWARD TRANSFER/);
  });
});
