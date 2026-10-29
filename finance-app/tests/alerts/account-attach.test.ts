import { describe, expect, it } from "vitest";
import {
  extractNarrationAccountLast4,
  formatHeldReasonCounts,
  heldReasonOf,
  heldReasonTag,
  isPossiblyAnotherAccount,
  POSSIBLY_ANOTHER_ACCOUNT,
  shownAccountLast4s,
} from "@/core/alerts/account-attach";

describe("own-account last-4 on an email alert", () => {
  it("reads a labelled account in the narration and ignores a counterparty mask", () => {
    expect(extractNarrationAccountLast4("Acct:******7643 POS SYNTHETIC MART")).toBe("7643");
    expect(extractNarrationAccountLast4("on your account ******7643")).toBe("7643");
    expect(extractNarrationAccountLast4("NIP/TRANSFER/TO ADA ******7643")).toBeUndefined();
    expect(shownAccountLast4s({ accountLast4: "2468", description: "NIP/TRANSFER/TO ADA ******7643" })).toEqual(["2468"]);
    expect(shownAccountLast4s({ description: "Acct:******7643 POS SYNTHETIC MART" })).toEqual(["7643"]);
    expect(shownAccountLast4s({ description: "POS SYNTHETIC MART LEKKI" })).toEqual([]);
  });

  it("tags held reasons without storing amounts or last-4s in the label", () => {
    expect(heldReasonTag("last-4")).toBe(`${POSSIBLY_ANOTHER_ACCOUNT}:last-4`);
    expect(heldReasonOf(heldReasonTag("balance"))).toBe("balance");
    expect(isPossiblyAnotherAccount(heldReasonTag("last-4"))).toBe(true);
    expect(formatHeldReasonCounts([{ reason: "last-4", count: 2 }, { reason: "balance", count: 0 }])).toBe(
      "Held reasons (open):\nlast-4\t2",
    );
    expect(formatHeldReasonCounts([{ reason: "last-4", count: 0 }, { reason: "balance", count: 0 }])).toBe(
      "Held reasons (open): none",
    );
  });
});
