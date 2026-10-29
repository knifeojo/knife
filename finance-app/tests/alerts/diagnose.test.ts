import { describe, expect, it } from "vitest";
import { GTBANK_FIXTURES as F, GTBANK_REGRESSION as R } from "@/core/fixtures/gtbank-alerts";
import { alertFingerprint, diagnoseFailedEmail, formatAlertFingerprint, maskSubjectDigits } from "@/core/alerts/diagnose";

describe("alerts:diagnose fingerprints", () => {
  it("masks digits in the subject and lists labels without values", () => {
    expect(maskSubjectDigits("GeNS Transaction Alert [Debit: NGN76,430.00]")).toBe(
      "GeNS Transaction Alert [Debit: NGN##,###.##]",
    );
    const fp = alertFingerprint(R.gensNestedNbspTable);
    expect(fp.subject).toBe("Transaction Alert");
    expect(fp.sender.toLowerCase()).toContain("gtbank.com");
    expect(fp.labels).toEqual(
      expect.arrayContaining([
        "Account Number",
        "Transaction Location",
        "Description",
        "Amount",
        "Value Date",
        "Remarks",
        "Time of Transaction",
        "Document Number",
        "Available Balance",
      ]),
    );
    const line = formatAlertFingerprint(fp);
    expect(line).not.toMatch(/76,430|900,000|\*{2,}2468|ADA OKAFOR|RENT OCT/i);
    expect(line).toContain("Account Number");
    expect(line).toContain("Available Balance");
  });

  it("prints a fingerprint only for recognised alerts that fail to parse", () => {
    const failed = diagnoseFailedEmail(F.malformedAlert);
    expect(failed).toBeTruthy();
    expect(failed).toContain("GeNS Transaction Alert");
    expect(failed).toContain("gens@gtbank.com");
    expect(failed).not.toMatch(/NGN ###|Amount : NGN/i);

    expect(diagnoseFailedEmail(R.gensNestedNbspTable)).toBeNull();
    expect(diagnoseFailedEmail(F.marketing)).toBeNull();
  });
});
