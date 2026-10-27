import { describe, expect, it } from "vitest";
import { parseAlert, parserRegistryJson, ALERT_PARSERS } from "@/core/alerts/registry";
import { isAllowedSmsSender, isPhoneSender } from "@/core/alerts/senders";
import type { AlertMessage } from "@/core/alerts/types";

function sms(sender: string, body: string, receivedAt = new Date("2026-10-03T15:29:00Z")): AlertMessage {
  return { channel: "sms", sender, body, receivedAt };
}

const GT_DR = `Acct:******1234
Amt:NGN2,800.00 DR
Desc:OUTWARD TRANSFER TO MONIEMFB - JOHN DOE
Bal:NGN354,145.94
Date:2026-10-03 4:29PM`;

const GT_FEE = `Acct:******1234
Amt:NGN10.00 DR
Desc:Commission on NIP Transfer
Bal:NGN354,135.94
Date:2026-10-03 4:29PM`;

const GT_CR = `Acct:******1234
Amt:NGN645,242.76 CR
Desc:- - PAYMENTDEEL INC-WRAMFB-GRP .
Bal:NGN672,045.70
Date:2026-10-03 1:23PM`;

const FB_DR = "Debit: 309XXXX867 Amt: NGN10,000.00 Date: 29-SEP-2026 19:50:38 Desc: FIP:MB:MMB/The Fresh Place / THE FRESH . Bal: NGN30,159.33CR. Dial *894*11# to get loan";
const FB_DR2 = "Debit: 309XXXX867 Amt: NGN15,000.00 Date: 28-SEP-2026 23:14:51 Desc: FIP:MB:OPY/JOHN DOE SMITH/JOHN DOE. Bal: NGN40,336.21CR. Dial *894*11# to get loan";
const FB_CR = "Credit: 309XXXX867 Amt: NGN485,750.00 Date: 26-SEP-2026 04:18:32 Desc: FIP:FCM/JOHN SAMUEL/APIJOHN. Bal: NGN1,249,349.61CR Pay with FirstOnline";
const FB_CR2 = "Credit: 309XXXX867 Amt: NGN922,925.00 Date: 25-SEP-2026 18:57:30 Desc: ISW:MMB/Acme Payroll Limite/JOHN SAMU. Bal: NGN924,367.87CR Pay with FirstOnline";

const ST_OUT = "Money Out! You have spent, NGN6,969.00 at APPLE.COM/BILL CORK         IE from ******8537 at 2026-09-25 13:48:14. You have NGN8,790.31";
const ST_IN = "Money In! NGN250,000.00 has arrived from DOE JOHN SAMUEL into ******8537 at 2026-09-30 18:24:12. You have NGN256,176.61";
const ST_MARKETING = "STERLING: keep transacting to stay eligible for AlwaysOn Overdraft. T&Cs apply.";
const FB_MARKETING = "Congratulations! You have a loan offer up to N300,000. Dial *894*11# to get started.";
const PROVIDUS = "Debit Alert: NGN17,000.00 MOB: To MONIEPOINT MICROFINANCE BANK|truncated";

describe("GTBank SMS", () => {
  it("parses a debit transfer at high confidence", () => {
    const r = parseAlert(sms("GTBank", GT_DR));
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.parser).toBe("GTBankSmsParser");
    expect(r.transaction.type).toBe("DEBIT");
    expect(r.transaction.amountMinor).toBe(280_000n);
    expect(r.transaction.balanceAfterMinor).toBe(35_414_594n);
    expect(r.transaction.accountLast4).toBe("1234");
    expect(r.transaction.description).toContain("OUTWARD TRANSFER");
    expect(r.transaction.transactionDate.toISOString()).toBe("2026-10-03T15:29:00.000Z");
    expect(r.transaction.autoPost).toBe(true);
    expect(r.transaction.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("parses a commission fee", () => {
    const r = parseAlert(sms("GTBank", GT_FEE));
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.transaction.amountMinor).toBe(1_000n);
    expect(r.transaction.description).toMatch(/Commission on NIP Transfer/i);
  });

  it("parses a credit and trims PAYMENTDEEL desc", () => {
    const r = parseAlert(sms("GTBank", GT_CR));
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.transaction.type).toBe("CREDIT");
    expect(r.transaction.amountMinor).toBe(64_524_276n);
    expect(r.transaction.description).toBe("PAYMENTDEEL INC-WRAMFB-GRP");
    expect(r.transaction.transactionDate.toISOString()).toBe("2026-10-03T12:23:00.000Z");
  });
});

describe("FirstBank SMS", () => {
  it("parses debit and strips marketing after the balance", () => {
    const r = parseAlert(sms("FirstBank", FB_DR));
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.transaction.amountMinor).toBe(1_000_000n);
    expect(r.transaction.description).toMatch(/Fresh Place/i);
    expect(r.transaction.description).not.toMatch(/Dial/);
    expect(r.transaction.balanceAfterMinor).toBe(3_015_933n);
    expect(r.transaction.accountLast4).toBe("9867");
    expect(r.transaction.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("parses a person-to-person debit", () => {
    const r = parseAlert(sms("FirstBank", FB_DR2));
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.transaction.amountMinor).toBe(1_500_000n);
    expect(r.transaction.description).toMatch(/JOHN DOE SMITH/i);
  });

  it("parses credits at high confidence", () => {
    const a = parseAlert(sms("FirstBank", FB_CR));
    const b = parseAlert(sms("FirstBank", FB_CR2));
    expect(a.status).toBe("parsed");
    expect(b.status).toBe("parsed");
    if (a.status !== "parsed" || b.status !== "parsed") return;
    expect(a.transaction.type).toBe("CREDIT");
    expect(a.transaction.amountMinor).toBe(48_575_000n);
    expect(b.transaction.amountMinor).toBe(92_292_500n);
    expect(b.transaction.description).toMatch(/Acme Payroll/i);
    expect(a.transaction.autoPost).toBe(true);
  });

  it("ignores FirstBank loan-offer marketing", () => {
    expect(parseAlert(sms("FirstBank", FB_MARKETING)).status).toBe("skipped");
  });
});

describe("Sterling SMS", () => {
  it("parses Money Out and collapses merchant spaces", () => {
    const r = parseAlert(sms("STERLING", ST_OUT));
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.transaction.type).toBe("DEBIT");
    expect(r.transaction.amountMinor).toBe(696_900n);
    expect(r.transaction.description).toMatch(/APPLE\.COM\/BILL/);
    expect(r.transaction.accountLast4).toBe("8537");
    expect(r.transaction.balanceAfterMinor).toBe(879_031n);
  });

  it("parses Money In", () => {
    const r = parseAlert(sms("Sterling", ST_IN));
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.transaction.type).toBe("CREDIT");
    expect(r.transaction.amountMinor).toBe(25_000_000n);
    expect(r.transaction.description).toBe("DOE JOHN SAMUEL");
  });

  it("ignores AlwaysOn marketing", () => {
    expect(parseAlert(sms("STERLING", ST_MARKETING)).status).toBe("skipped");
  });
});

describe("Providus stub + generic fallback", () => {
  it("extracts amount and direction at low confidence and sends to Review", () => {
    const r = parseAlert(sms("PROVIDUS", PROVIDUS));
    expect(r.status).toBe("review");
    if (r.status !== "review") return;
    expect(r.transaction.amountMinor).toBe(1_700_000n);
    expect(r.transaction.type).toBe("DEBIT");
    expect(r.transaction.description).toMatch(/MONIEPOINT/i);
    expect(r.transaction.autoPost).toBe(false);
  });

  it("fallback regex is low-confidence Review, never auto-post", () => {
    const r = parseAlert({
      channel: "email",
      sender: "alerts@unknown-bank.test",
      subject: "Debit Alert",
      body: "Amt: NGN12,500.00 DR  Bal: NGN90,000.00  Desc: POS SHOP",
      receivedAt: new Date(),
    });
    expect(r.status).toBe("review");
    if (r.status !== "review") return;
    expect(r.parser).toBe("GenericFallback");
    expect(r.transaction.amountMinor).toBe(1_250_000n);
    expect(r.transaction.autoPost).toBe(false);
    expect(r.transaction.confidence).toBeLessThan(0.5);
  });
});

describe("sender allowlist", () => {
  it("allows bank sender IDs and refuses telcos and phone numbers", () => {
    expect(isAllowedSmsSender("GTBank")).toBe(true);
    expect(isAllowedSmsSender("FirstBank")).toBe(true);
    expect(isAllowedSmsSender("STERLING")).toBe(true);
    expect(isAllowedSmsSender("303")).toBe(false);
    expect(isAllowedSmsSender("GloDataSale")).toBe(false);
    expect(isAllowedSmsSender("GLO-ROAM")).toBe(false);
    expect(isAllowedSmsSender("VIDEO")).toBe(false);
    expect(isAllowedSmsSender("getmigo")).toBe(false);
    expect(isAllowedSmsSender("MYD ALERT")).toBe(false);
    expect(isAllowedSmsSender("+2348012345678")).toBe(false);
    expect(isPhoneSender("08012345678")).toBe(true);
    expect(parseAlert(sms("+2348012345678", GT_DR)).status).toBe("skipped");
  });
});

describe("stubs and registry JSON", () => {
  it("registers First Bank / Sterling email stubs that never match", () => {
    const stubs = ALERT_PARSERS.filter((p) => p.stub);
    expect(stubs.map((p) => p.name)).toEqual(expect.arrayContaining(["FirstBankEmailParser", "SterlingEmailParser"]));
    const msg: AlertMessage = { channel: "email", sender: "alerts@firstbanknigeria.com", subject: "Debit", body: "TODO sample", receivedAt: new Date() };
    expect(parseAlert(msg).status).toBe("skipped");
  });

  it("exports senders for the phone", () => {
    const json = parserRegistryJson();
    expect(json.smsSenders).toEqual(expect.arrayContaining(["GTBank", "FirstBank", "STERLING"]));
    expect(json.blocked).toContain("GloDataSale");
  });
});
