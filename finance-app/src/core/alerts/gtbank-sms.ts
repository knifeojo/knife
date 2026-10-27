import { lastDigits, parseAlertDate, parseMoney, trimDesc } from "./money";
import type { AlertMessage, AlertParser, ParsedAlert } from "./types";

// Exact GTBank SMS layout (sender ID "GTBank"). Lines are newline-separated; Desc can wrap.
//
//   Acct:******1234
//   Amt:NGN3,450.00 DR
//   Desc:OUTWARD TRANSFER TO MONIEMFB - JOHN DOE
//   Bal:NGN412,890.50
//   Date:2026-10-07 3:17PM

const ACCT = /Acct:\s*([*\dX]+)/i;
const AMT = /Amt:\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)\s*(DR|CR)/i;
const BAL = /Bal:\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)/i;
const DATE = /Date:\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i;

function bodyOf(msg: AlertMessage): string {
  return msg.body.replace(/\r/g, "");
}

function descriptionOf(body: string): string {
  const start = body.search(/Desc:\s*/i);
  if (start < 0) return "";
  const rest = body.slice(start).replace(/^Desc:\s*/i, "");
  const cut = rest.search(/\n\s*(Bal|Date):/i);
  return trimDesc((cut >= 0 ? rest.slice(0, cut) : rest).replace(/\n/g, " "));
}

export class GTBankSmsParser implements AlertParser {
  readonly name = "GTBankSmsParser";
  readonly institution = "GTBank";
  readonly channels = ["sms"] as const;
  readonly senders = ["GTBank"];

  canParse(msg: AlertMessage): boolean {
    if (msg.channel !== "sms") return false;
    if (!/^gtbank$/i.test(msg.sender.trim())) return false;
    const body = bodyOf(msg);
    return ACCT.test(body) && AMT.test(body);
  }

  parse(msg: AlertMessage): ParsedAlert | null {
    const body = bodyOf(msg);
    const amt = body.match(AMT);
    const money = parseMoney(amt?.[0]);
    if (!amt || !money || money.minor <= 0n) return null;
    const type = amt[3].toUpperCase() === "CR" ? "CREDIT" : "DEBIT";
    const bal = parseMoney(body.match(BAL)?.[0]);
    const date = body.match(DATE);
    const accountLast4 = lastDigits(body.match(ACCT)?.[1]);
    const description = descriptionOf(body) || `GTBank ${type === "DEBIT" ? "debit" : "credit"}`;

    const found = [true, true, !!date, !!description, !!bal, !!accountLast4];
    const confidence = Math.round((found.filter(Boolean).length / found.length) * 100) / 100;

    return {
      institution: this.institution,
      type,
      amountMinor: money.minor,
      currency: money.currency ?? bal?.currency ?? "NGN",
      transactionDate: parseAlertDate(date?.[1], date?.[2], msg.receivedAt),
      description: description.slice(0, 280),
      balanceAfterMinor: bal?.minor,
      accountLast4,
      confidence,
      autoPost: confidence >= 0.75,
    };
  }
}
