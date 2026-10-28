import { describe, expect, it } from "vitest";
import { recategorizeUnpaired, shouldNeverPair } from "@/core/fx/pairing-rules";

describe("pairing-rules", () => {
  it("does not treat a glued PAYMENTDEEL credit as a third-party sender", () => {
    expect(shouldNeverPair(
      { category: "Own transfer", description: "Money transfer to Ada Eze / Deel withdrawal", counterparty: "Ada Eze" },
      { counterparty: "PAYMENTDEEL INC", description: "PAYMENTDEEL INC-WRAMFB-GRP" },
      ["Ada Eze"],
    )).toBe(false);
  });

  it("does not treat payout rails as third-party senders", () => {
    const debit = { category: "Own transfer", description: "Money transfer to Ada Eze", counterparty: "Ada Eze" };
    for (const credit of [
      { counterparty: "Kora", description: "NIP CREDIT KORA" },
      { counterparty: "dLocal", description: "NIP FROM DLOCAL LIMITED" },
      { counterparty: "Moniepoint", description: "W5WM-MONIE MFB-PAYOUT" },
      { counterparty: "VFD", description: "NIP CREDIT VFD MFB" },
    ]) {
      expect(shouldNeverPair(debit, credit, ["Ada Eze"]), credit.counterparty).toBe(false);
    }
  });

  it("recategorizes an own-name unpaired credit as Own transfer, not Income", () => {
    const c = recategorizeUnpaired({
      description: "TRANSFER FROM ADA EZE / PROVIDUS",
      type: "CREDIT",
      counterparty: "Ada Eze",
      owners: ["Ada Eze"],
    });
    expect(c.category).toBe("Own transfer");
  });

  it("recategorizes a loan-provider unpaired credit as Debt proceeds", () => {
    const c = recategorizeUnpaired({
      description: "NIP FROM FAIRMONEY MFB",
      type: "CREDIT",
      counterparty: "FairMoney",
      owners: ["Ada Eze"],
    });
    expect(c).toMatchObject({ category: "Debt", subcategory: "Loan proceeds" });
  });
});
