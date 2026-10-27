import { detectDirection, lastDigits, parseAlertDate, parseMoney } from "./money";
import type { AlertMessage, AlertParser, ParsedAlert } from "./types";

// Generic Nigerian alert shape: Amt/NGN/₦ amounts with commas, Dr/Cr/Debit/Credit, Bal/Avail Bal.
// Always low-confidence. Never auto-posts — Review only.

const AMOUNT = /(?:amt|amount)\s*[:\s]*\s*(?:NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)/i;
const BARE_NAIRA = /(?:NGN|₦)\s*([\d,]+(?:\.\d{1,2})?)/i;
const BAL = /(?:avail(?:able)?\.?\s*bal(?:ance)?|bal(?:ance)?)\s*[:\s]*\s*(?:NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)/i;
const ACCT = /(?:acct|account|a\/c)\s*[:\s]*\s*([*\dX]{4,})/i;
const DATE = /(?:date)\s*[:\s]*\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{1,2}-[A-Za-z]{3}-\d{4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?))?/i;
const DESC = /(?:desc|narration|details)\s*[:\s]*\s*(.+?)(?:\s+(?:Bal|Date|Ref)\b|$)/i;
const REF = /(?:ref(?:erence)?(?:\s*(?:no|number|id))?)\s*[:\s]*\s*([A-Z0-9-]{4,})/i;

export class GenericFallbackParser implements AlertParser {
  readonly name = "GenericFallback";
  readonly institution = "Unknown";
  readonly channels = ["email", "sms"] as const;
  readonly senders = [];

  canParse(msg: AlertMessage): boolean {
    const text = `${msg.subject ?? ""}\n${msg.body}`;
    const money = AMOUNT.test(text) || BARE_NAIRA.test(text);
    const dir = detectDirection(text);
    return !!(money && dir);
  }

  parse(msg: AlertMessage): ParsedAlert | null {
    const text = `${msg.subject ?? ""}\n${msg.body}`;
    const type = detectDirection(text);
    const amtRaw = text.match(AMOUNT)?.[1] ?? text.match(BARE_NAIRA)?.[1];
    const money = parseMoney(amtRaw);
    if (!type || !money || money.minor <= 0n) return null;
    const bal = parseMoney(text.match(BAL)?.[1]);
    const date = text.match(DATE);
    const desc = text.match(DESC)?.[1]?.trim();

    return {
      institution: this.institution,
      type,
      amountMinor: money.minor,
      currency: money.currency ?? "NGN",
      transactionDate: parseAlertDate(date?.[1], date?.[2], msg.receivedAt),
      description: (desc || `${type === "DEBIT" ? "Debit" : "Credit"} alert`).slice(0, 280),
      reference: text.match(REF)?.[1],
      balanceAfterMinor: bal?.minor,
      accountLast4: lastDigits(text.match(ACCT)?.[1]),
      confidence: 0.35,
      autoPost: false,
    };
  }
}
