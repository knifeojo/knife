import { describe, expect, it } from "vitest";
import { extractNarrationAccountLast4, shownAccountLast4s } from "@/core/alerts/account-attach";

describe("own-account last-4 on an email alert", () => {
  it("reads a labelled account in the narration and ignores a counterparty mask", () => {
    expect(extractNarrationAccountLast4("Acct:******7643 POS SYNTHETIC MART")).toBe("7643");
    expect(extractNarrationAccountLast4("on your account ******7643")).toBe("7643");
    expect(extractNarrationAccountLast4("NIP/TRANSFER/TO ADA ******7643")).toBeUndefined();
    expect(shownAccountLast4s({ accountLast4: "2468", description: "NIP/TRANSFER/TO ADA ******7643" })).toEqual(["2468"]);
    expect(shownAccountLast4s({ description: "Acct:******7643 POS SYNTHETIC MART" })).toEqual(["7643"]);
    expect(shownAccountLast4s({ description: "POS SYNTHETIC MART LEKKI" })).toEqual([]);
  });
});
