import { detectDirection, lastDigits, parseAlertDate, parseMoney } from "./money";
import type { AlertMessage, AlertParser, ParsedAlert } from "./types";

// Generic alert shape used when no bank-specific parser matches.
// Amount, direction, balance, masked last-4, and narration. Always low-confidence: Review, never auto-post.

const CURRENCY = "NGN|USD|GBP|EUR|₦|\\$|£|€|N";
const AMOUNT = new RegExp(`(?:amt|amount)\\s*[:\\s]*\\s*(${CURRENCY})?\\s*([\\d,]+(?:\\.\\d{1,2})?)`, "i");
const BARE = new RegExp(`(${CURRENCY})\\s*([\\d,]+(?:\\.\\d{1,2})?)`, "i");
const BAL = /((?:avl|avail(?:able)?)\.?\s*)?bal(?:ance)?\s*[:\s]\s*(?:NGN|USD|GBP|EUR|₦|\$|£|€|N)?\s*([\d,]+(?:\.\d{1,2})?)/i;
const ACCT = /(?:acct|account|a\/c)\s*[:\s]*\s*([*xX\d]{4,})/i;
const MASKED = /((?:\*{2,}|[xX]{2,})\d{3,6}|\d{3,}(?:\*{2,}|[xX]{2,})\d{2,4})/;
const DATE = /(?:date)\s*[:\s]*\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{1,2}-[A-Za-z]{3}-\d{4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?))?/i;
const DESC = /(?:desc|narration|details)\s*[:\s]\s*(.+?)(?:\s+(?:Bal|Avl|Date|Ref)\b|$)/i;
const REF = /(?:ref(?:erence)?(?:\s*(?:no|number|id))?)\s*[:\s]*\s*([A-Z0-9-]{4,})/i;

function currencyOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const token = raw.trim().toUpperCase();
  if (token === "N" || token === "₦") return "NGN";
  if (token === "$") return "USD";
  if (token === "£") return "GBP";
  if (token === "€") return "EUR";
  return token || undefined;
}

function amountIn(text: string): { minor: bigint; currency: string } | undefined {
  const stripped = text.replace(BAL, " ");
  const match = stripped.match(AMOUNT) ?? stripped.match(BARE);
  if (!match) return undefined;
  const money = parseMoney(match[2]);
  if (!money || money.minor <= 0n) return undefined;
  return { minor: money.minor, currency: currencyOf(match[1]) ?? money.currency ?? "NGN" };
}

export class GenericFallbackParser implements AlertParser {
  readonly name = "GenericFallback";
  readonly institution = "Unknown";
  readonly channels = ["email", "sms"] as const;
  readonly senders = [];

  canParse(msg: AlertMessage): boolean {
    const text = `${msg.subject ?? ""}\n${msg.body}`;
    return !!(amountIn(text) && detectDirection(text));
  }

  parse(msg: AlertMessage): ParsedAlert | null {
    const text = `${msg.subject ?? ""}\n${msg.body}`;
    const type = detectDirection(text);
    const money = amountIn(text);
    if (!type || !money) return null;
    const bal = parseMoney(text.match(BAL)?.[2]);
    const date = text.match(DATE);
    const desc = text.match(DESC)?.[1]?.trim();
    const acct = text.match(ACCT)?.[1] ?? text.match(MASKED)?.[1];
    const sender = msg.sender.trim();

    return {
      institution: msg.channel === "sms" && sender ? sender.slice(0, 80) : this.institution,
      type,
      amountMinor: money.minor,
      currency: money.currency,
      transactionDate: parseAlertDate(date?.[1], date?.[2], msg.receivedAt),
      description: (desc || `${type === "DEBIT" ? "Debit" : "Credit"} alert`).slice(0, 280),
      reference: text.match(REF)?.[1],
      balanceAfterMinor: bal?.minor,
      accountLast4: lastDigits(acct),
      confidence: 0.35,
      autoPost: false,
    };
  }
}
