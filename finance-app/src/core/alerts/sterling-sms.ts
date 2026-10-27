import { lastDigits, normalizeMerchant, parseAlertDate, parseMoney, trimDesc } from "./money";
import type { AlertMessage, AlertParser, ParsedAlert } from "./types";

// Sterling Bank SMS (sender "STERLING" / "Sterling"). Natural language.
//   Money Out! You have spent, NGN4,812.00 at APPLE.COM/BILL CORK         IE from ******4321 at 2026-10-08 10:15:33. You have NGN15,640.88
//   Money In! NGN180,000.00 has arrived from DOE JOHN SAMUEL into ******4321 at 2026-10-11 17:36:41. You have NGN195,640.88

const OUT =
  /Money Out!\s*You have spent,\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)\s+at\s+(.+?)\s+from\s+([*\dX]+)\s+at\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\.\s*You have\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)/i;
const IN =
  /Money In!\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)\s+has arrived from\s+(.+?)\s+into\s+([*\dX]+)\s+at\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\.\s*You have\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)/i;

export class SterlingSmsParser implements AlertParser {
  readonly name = "SterlingSmsParser";
  readonly institution = "Sterling Bank";
  readonly channels = ["sms"] as const;
  readonly senders = ["STERLING", "Sterling"];

  canParse(msg: AlertMessage): boolean {
    if (msg.channel !== "sms") return false;
    if (!/^sterling$/i.test(msg.sender.trim())) return false;
    const body = msg.body.replace(/\s+/g, " ");
    return OUT.test(body) || IN.test(body);
  }

  parse(msg: AlertMessage): ParsedAlert | null {
    const body = msg.body.replace(/\s+/g, " ");
    const out = body.match(OUT);
    const inn = out ? null : body.match(IN);
    const m = out ?? inn;
    if (!m) return null;
    const money = parseMoney(m[2]);
    if (!money || money.minor <= 0n) return null;
    const type = out ? "DEBIT" : "CREDIT";
    const party = out ? normalizeMerchant(m[3]) : trimDesc(m[3]);
    const bal = parseMoney(m[8]);

    return {
      institution: this.institution,
      type,
      amountMinor: money.minor,
      currency: money.currency ?? "NGN",
      transactionDate: parseAlertDate(m[5], m[6], msg.receivedAt),
      description: party.slice(0, 280),
      balanceAfterMinor: bal?.minor,
      accountLast4: lastDigits(m[4]),
      confidence: 0.92,
      autoPost: true,
    };
  }
}
