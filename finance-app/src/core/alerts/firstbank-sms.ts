import { lastDigits, parseAlertDate, parseMoney, trimDesc } from "./money";
import type { AlertMessage, AlertParser, ParsedAlert } from "./types";

// FirstBank SMS (sender "FirstBank"). One physical line; wraps on screen.
// Debit:  309XXXX867 Amt: NGN10,000.00 Date: 29-SEP-2026 19:50:38 Desc: FIP:MB:MMB/The Fresh Place / THE FRESH . Bal: NGN30,159.33CR. Dial *894*11# to get loan
// Credit: 309XXXX867 Amt: NGN485,750.00 Date: 26-SEP-2026 04:18:32 Desc: FIP:FCM/JOHN SAMUEL/APIJOHN. Bal: NGN1,249,349.61CR Pay with FirstOnline
//
// Trailing marketing after the balance is stripped. Desc prefixes: FIP:MB:<code>/, FIP:FCM/, ISW:MMB/.

const LINE =
  /^(Debit|Credit):\s*(\S+)\s+Amt:\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)\s+Date:\s*(\d{2}-[A-Za-z]{3}-\d{4})\s+(\d{2}:\d{2}:\d{2})\s+Desc:\s*(.+?)\s+Bal:\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)(CR|DR)?/i;

const PREFIX = /^(?:FIP|ISW):[A-Z]{2,4}(?::[A-Z0-9]+)?\//i;

function cleanDesc(raw: string): string {
  let s = raw.trim();
  s = s.replace(PREFIX, "");
  // "Full Name/Truncated Name" — keep the longer side.
  const parts = s.split("/").map((p) => trimDesc(p)).filter(Boolean);
  if (parts.length >= 2) {
    const a = parts[0];
    const b = parts[1];
    s = a.length >= b.length ? a : `${a} / ${b}`;
  } else {
    s = trimDesc(s);
  }
  return s;
}

export class FirstBankSmsParser implements AlertParser {
  readonly name = "FirstBankSmsParser";
  readonly institution = "First Bank";
  readonly channels = ["sms"] as const;
  readonly senders = ["FirstBank"];

  canParse(msg: AlertMessage): boolean {
    if (msg.channel !== "sms") return false;
    if (!/^firstbank$/i.test(msg.sender.trim())) return false;
    return LINE.test(msg.body.replace(/\s+/g, " ").trim());
  }

  parse(msg: AlertMessage): ParsedAlert | null {
    const line = msg.body.replace(/\s+/g, " ").trim();
    const m = line.match(LINE);
    if (!m) return null;
    const money = parseMoney(m[4]);
    if (!money || money.minor <= 0n) return null;
    const type = /^credit$/i.test(m[1]) ? "CREDIT" : "DEBIT";
    const bal = parseMoney(m[9]);
    const overdrawn = (m[10] ?? "").toUpperCase() === "DR";
    const description = cleanDesc(m[7]) || `First Bank ${type === "DEBIT" ? "debit" : "credit"}`;

    return {
      institution: this.institution,
      type,
      amountMinor: money.minor,
      currency: money.currency ?? "NGN",
      transactionDate: parseAlertDate(m[5], m[6], msg.receivedAt),
      description: description.slice(0, 280),
      balanceAfterMinor: bal ? (overdrawn ? -bal.minor : bal.minor) : undefined,
      accountLast4: lastDigits(m[2]),
      confidence: 0.95,
      autoPost: true,
    };
  }
}
