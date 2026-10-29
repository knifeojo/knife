import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { GTBANK_FIXTURES as F, GTBANK_REGRESSION as R } from "@/core/fixtures/gtbank-alerts";
import { heldReasonTag } from "@/core/alerts/account-attach";
import { alertFingerprint, diagnoseFailedEmail, diagnoseHeldReasonCounts, formatAlertFingerprint, maskSubjectDigits } from "@/core/alerts/diagnose";

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

describe("alerts:diagnose held-reason counts", () => {
  it("prints open held-reason counts without values", async () => {
    const user = await db.user.create({ data: { email: "diagnose-held@test.dev" } });
    await db.unparsedAlert.createMany({
      data: [
        { userId: user.id, channel: "email", sender: "GTBank", receivedAt: new Date("2026-10-03T10:00:00Z"), rawText: "held one", reason: heldReasonTag("last-4") },
        { userId: user.id, channel: "email", sender: "GTBank", receivedAt: new Date("2026-10-03T11:00:00Z"), rawText: "held two", reason: heldReasonTag("last-4") },
        { userId: user.id, channel: "email", sender: "GTBank", receivedAt: new Date("2026-10-03T12:00:00Z"), rawText: "held three", reason: heldReasonTag("balance") },
        { userId: user.id, channel: "email", sender: "GTBank", receivedAt: new Date("2026-10-03T13:00:00Z"), rawText: "unparsed", reason: "unparsed" },
      ],
    });
    const line = await diagnoseHeldReasonCounts(user.id);
    expect(line).toContain("Held reasons (open):");
    expect(line).toContain("last-4\t2");
    expect(line).toContain("balance\t1");
    expect(line).not.toMatch(/76,430|900,000|2468|NGN/i);
  });
});
