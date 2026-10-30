import { describe, expect, it } from "vitest";
import { parseAlert, parserRegistryJson, ALERT_PARSERS } from "@/core/alerts/registry";
import { isAllowedPushSender, isAllowedSmsSender, isKnownBankSender, isPhoneSender } from "@/core/alerts/senders";
import type { AlertMessage } from "@/core/alerts/types";

function sms(sender: string, body: string, receivedAt = new Date("2026-10-07T14:17:00Z")): AlertMessage {
  return { channel: "sms", sender, body, receivedAt };
}

const GT_DR = `Acct:******1234
Amt:NGN3,450.00 DR
Desc:OUTWARD TRANSFER TO MONIEMFB - JOHN DOE
Bal:NGN412,890.50
Date:2026-10-07 3:17PM`;

const GT_FEE = `Acct:******1234
Amt:NGN25.00 DR
Desc:Commission on NIP Transfer
Bal:NGN412,865.50
Date:2026-10-07 3:17PM`;

const GT_CR = `Acct:******1234
Amt:NGN518,390.25 CR
Desc:- - PAYMENTDEEL INC-WRAMFB-GRP .
Bal:NGN540,120.80
Date:2026-10-07 11:08AM`;

const FB_DR = "Debit: 301XXXX123 Amt: NGN12,500.00 Date: 22-OCT-2026 18:41:09 Desc: FIP:MB:MMB/The Fresh Place / THE FRESH . Bal: NGN41,280.44CR. Dial *894*11# to get loan";
const FB_DR2 = "Debit: 301XXXX123 Amt: NGN18,750.00 Date: 21-OCT-2026 21:03:27 Desc: FIP:MB:OPY/JOHN DOE SMITH/JOHN DOE. Bal: NGN53,780.44CR. Dial *894*11# to get loan";
const FB_CR = "Credit: 301XXXX123 Amt: NGN372,400.00 Date: 20-OCT-2026 06:22:14 Desc: FIP:FCM/JOHN SAMUEL/APIJOHN. Bal: NGN892,610.18CR Pay with FirstOnline";
const FB_CR2 = "Credit: 301XXXX123 Amt: NGN614,880.00 Date: 19-OCT-2026 16:11:05 Desc: ISW:MMB/Acme Payroll Limite/JOHN SAMU. Bal: NGN618,210.18CR Pay with FirstOnline";

const ST_OUT = "Money Out! You have spent, NGN4,812.00 at APPLE.COM/BILL CORK         IE from ******4321 at 2026-10-08 10:15:33. You have NGN15,640.88";
const ST_IN = "Money In! NGN180,000.00 has arrived from DOE JOHN SAMUEL into ******4321 at 2026-10-11 17:36:41. You have NGN195,640.88";
const ST_MARKETING = "STERLING: keep transacting to stay eligible for AlwaysOn Overdraft. T&Cs apply.";
const FB_MARKETING = "Congratulations! You have a loan offer up to N300,000. Dial *894*11# to get started.";
const PROVIDUS = "Debit Alert: NGN22,500.00 MOB: To MONIEPOINT MICROFINANCE BANK|truncated";

describe("GTBank SMS", () => {
  it("parses a debit transfer at high confidence", () => {
    const r = parseAlert(sms("GTBank", GT_DR));
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.parser).toBe("GTBankSmsParser");
    expect(r.transaction.type).toBe("DEBIT");
    expect(r.transaction.amountMinor).toBe(345_000n);
    expect(r.transaction.balanceAfterMinor).toBe(41_289_050n);
    expect(r.transaction.accountLast4).toBe("1234");
    expect(r.transaction.description).toContain("OUTWARD TRANSFER");
    expect(r.transaction.transactionDate.toISOString()).toBe("2026-10-07T14:17:00.000Z");
    expect(r.transaction.autoPost).toBe(true);
    expect(r.transaction.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("parses a commission fee", () => {
    const r = parseAlert(sms("GTBank", GT_FEE));
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.transaction.amountMinor).toBe(2_500n);
    expect(r.transaction.description).toMatch(/Commission on NIP Transfer/i);
  });

  it("parses a credit and trims PAYMENTDEEL desc", () => {
    const r = parseAlert(sms("GTBank", GT_CR));
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.transaction.type).toBe("CREDIT");
    expect(r.transaction.amountMinor).toBe(51_839_025n);
    expect(r.transaction.description).toBe("PAYMENTDEEL INC-WRAMFB-GRP");
    expect(r.transaction.transactionDate.toISOString()).toBe("2026-10-07T10:08:00.000Z");
  });
});

describe("FirstBank SMS", () => {
  it("parses debit and strips marketing after the balance", () => {
    const r = parseAlert(sms("FirstBank", FB_DR));
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.transaction.amountMinor).toBe(1_250_000n);
    expect(r.transaction.description).toMatch(/Fresh Place/i);
    expect(r.transaction.description).not.toMatch(/Dial/);
    expect(r.transaction.balanceAfterMinor).toBe(4_128_044n);
    expect(r.transaction.accountLast4).toBe("1123");
    expect(r.transaction.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("parses a person-to-person debit", () => {
    const r = parseAlert(sms("FirstBank", FB_DR2));
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.transaction.amountMinor).toBe(1_875_000n);
    expect(r.transaction.description).toMatch(/JOHN DOE SMITH/i);
  });

  it("parses credits at high confidence", () => {
    const a = parseAlert(sms("FirstBank", FB_CR));
    const b = parseAlert(sms("FirstBank", FB_CR2));
    expect(a.status).toBe("parsed");
    expect(b.status).toBe("parsed");
    if (a.status !== "parsed" || b.status !== "parsed") return;
    expect(a.transaction.type).toBe("CREDIT");
    expect(a.transaction.amountMinor).toBe(37_240_000n);
    expect(b.transaction.amountMinor).toBe(61_488_000n);
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
    expect(r.transaction.amountMinor).toBe(481_200n);
    expect(r.transaction.description).toMatch(/APPLE\.COM\/BILL/);
    expect(r.transaction.accountLast4).toBe("4321");
    expect(r.transaction.balanceAfterMinor).toBe(1_564_088n);
  });

  it("parses Money In", () => {
    const r = parseAlert(sms("Sterling", ST_IN));
    expect(r.status).toBe("parsed");
    if (r.status !== "parsed") return;
    expect(r.transaction.type).toBe("CREDIT");
    expect(r.transaction.amountMinor).toBe(18_000_000n);
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
    expect(r.transaction.amountMinor).toBe(2_250_000n);
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

const RENMONEY =
  "Credit of NGN15,000.00 into wallet ****4821. Avl Bal: NGN27,430.50. Desc: WALLET FUNDING FROM EMPLOYER";

describe("unknown financial senders", () => {
  it("sends a Renmoney-like text to Review and does not auto-post", () => {
    const r = parseAlert(sms("Renmoney", RENMONEY));
    expect(r.status).toBe("review");
    if (r.status !== "review") return;
    expect(r.parser).toBe("GenericFallback");
    expect(r.transaction.autoPost).toBe(false);
    expect(r.transaction.confidence).toBeLessThan(0.5);
    expect(r.transaction.type).toBe("CREDIT");
    expect(r.transaction.amountMinor).toBe(1_500_000n);
    expect(r.transaction.currency).toBe("NGN");
    expect(r.transaction.balanceAfterMinor).toBe(2_743_050n);
    expect(r.transaction.accountLast4).toBe("4821");
    expect(r.transaction.description).toMatch(/WALLET FUNDING FROM EMPLOYER/);
  });

  it("parses a USD debit with a masked account when no bank parser matches", () => {
    const r = parseAlert(
      sms("Renmoney", "Debit of USD20.50 at CARD. Bal: USD80.00. Desc: NETFLIX. Acct: ****0091"),
    );
    expect(r.status).toBe("review");
    if (r.status !== "review") return;
    expect(r.transaction.type).toBe("DEBIT");
    expect(r.transaction.amountMinor).toBe(2_050n);
    expect(r.transaction.currency).toBe("USD");
    expect(r.transaction.accountLast4).toBe("0091");
    expect(r.transaction.autoPost).toBe(false);
  });

  it("skips OTP and promo texts", () => {
    expect(parseAlert(sms("GTBank", "Your OTP is 482193. Do not share this code with anyone.")).status).toBe("skipped");
    expect(parseAlert(sms("Renmoney", "Your verification code is 849201. It expires in 5 minutes.")).status).toBe("skipped");
    expect(parseAlert(sms("Renmoney", "Congratulations! You have won N500,000. Dial *123# to claim.")).status).toBe("skipped");
  });
});

describe("push alerts", () => {
  it("knows bank app packages and does not treat them as email", () => {
    expect(isAllowedPushSender("com.gtbank.gtworld")).toBe(true);
    expect(isAllowedPushSender("com.firstbank.firstmobile")).toBe(true);
    expect(isKnownBankSender("com.gtbank.gtworld", "push")).toBe(true);
    expect(isKnownBankSender("com.gtbank.gtworld", "email")).toBe(false);
    expect(isKnownBankSender("alerts@gtbank.com", "push")).toBe(false);
    expect(isKnownBankSender("alerts@gtbank.com", "email")).toBe(true);
    expect(isAllowedPushSender("com.whatsapp")).toBe(false);
  });

  it("posts a GTBank-shaped notification and reviews an unmatched financial one", () => {
    const posted = parseAlert({ channel: "push", sender: "GTBank", body: GT_DR, receivedAt: new Date("2026-10-07T14:17:00Z") });
    expect(posted.status).toBe("parsed");

    const known = parseAlert({
      channel: "push",
      sender: "com.gtbank.gtworld",
      body: "Available balance NGN10,000.00",
      receivedAt: new Date("2026-10-07T14:17:00Z"),
    });
    expect(known.status).toBe("unparsed");

    const other = parseAlert({
      channel: "push",
      sender: "com.example.wallet",
      body: "Available balance NGN4,200.00",
      receivedAt: new Date("2026-10-07T14:17:00Z"),
    });
    expect(other.status).toBe("unparsed");

    expect(parseAlert({ channel: "push", sender: "com.example.wallet", body: "Your statement is ready", receivedAt: new Date() }).status).toBe("skipped");
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
