import { describe, expect, it } from "vitest";
import { categorize, type UserRule } from "@/core/categorize";
import { destinationLabelFor, inferDestination, isPersonWalletTransfer } from "@/core/destination";
import { aliasKey, type KnownPerson } from "@/core/people-match";

const person = (id: string, displayName: string, relationship: string): KnownPerson => ({
  id, displayName, relationship, aliases: [{ name: displayName, key: aliasKey(displayName), rejected: false }],
});

describe("destination hints", () => {
  it("reads Ghana MoMo, Nigerian bank, Benin and Kenya from the narration", () => {
    expect(inferDestination("Money transfer to KOFI MENSAH / +233201234567 / MTN")).toMatchObject({
      country: "Ghana", countryCode: "GH", currency: "GHS", channel: "mobile_money",
      label: "Sent to Ghana (mobile money)", personName: "Kofi Mensah", isPersonTransfer: true, confidence: 0.4,
    });
    expect(inferDestination("ADA EZE / 0123456789 / GTBank")).toMatchObject({
      country: "Nigeria", currency: "NGN", channel: "bank", label: "Sent to Nigeria", personName: "Ada Eze",
    });
    expect(inferDestination("Payment +22990111222")).toMatchObject({ country: "Benin", currency: "XOF" });
    expect(inferDestination("Payout +254711223344")).toMatchObject({ country: "Kenya", currency: "KES" });
    expect(destinationLabelFor("Ghana", "GHS")).toBe("Sent to Ghana (mobile money)");
  });

  it("does not treat a person wallet payout as MTN airtime", () => {
    const d = "Money transfer to KOFI MENSAH / +233201234567 / MTN";
    expect(isPersonWalletTransfer(d)).toBe(true);
    expect(categorize({ description: d, type: "DEBIT" })).toMatchObject({
      category: "Transfers", destinationCountry: "Ghana", destinationCurrency: "GHS",
    });
    expect(categorize({ description: d, type: "DEBIT" }).subcategory).not.toBe("Airtime & data");
    expect(categorize({ description: "MTN AIRTIME 1000", type: "DEBIT" })).toMatchObject({
      category: "Utilities", subcategory: "Airtime & data", merchantName: "MTN",
    });
  });

  it("a confirmed person wins over the MTN airtime rule; only Family/Spouse for a spouse", () => {
    const kofi = person("kofi", "Kofi Mensah", "spouse");
    const rules: UserRule[] = [{ pattern: "person:kofi", canonicalName: "Kofi Mensah", category: null, subcategory: null, person: kofi }];
    const d = "Money transfer to KOFI MENSAH / +233201234567 / Vodafone";
    expect(categorize({ description: d, type: "DEBIT" }, rules)).toMatchObject({
      category: "Family", subcategory: "Spouse", source: "user", personId: "kofi", destinationCountry: "Ghana",
    });
    expect(categorize({ description: "NIP TRANSFER TO KOFI MENSAH PARTNER", type: "DEBIT" }, rules)).toMatchObject({
      category: "Family", subcategory: "Spouse", personId: "kofi",
    });
  });
});
