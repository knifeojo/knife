import { parseMoney } from "./money";
import type { AlertMessage, AlertParser, ParsedAlert } from "./types";

// Providus (sender "PROVIDUS"). Only a truncated sample is known:
//   Debit Alert: NGN22,500.00 MOB: To MONIEPOINT MICROFINANCE BANK|...
// Low confidence: amount + direction + counterparty bank. Routes to Review.

const LINE = /^(Debit|Credit)\s+Alert:\s*(NGN|₦)?\s*([\d,]+(?:\.\d{1,2})?)\s+(?:MOB:\s*)?(?:To|From)?\s*(.+)$/i;

export class ProvidusSmsParser implements AlertParser {
  readonly name = "ProvidusSmsParser";
  readonly institution = "Providus Bank";
  readonly channels = ["sms"] as const;
  readonly senders = ["PROVIDUS"];
  readonly stub = false;

  canParse(msg: AlertMessage): boolean {
    if (msg.channel !== "sms") return false;
    if (!/^providus$/i.test(msg.sender.trim())) return false;
    return LINE.test(msg.body.replace(/\s+/g, " ").trim());
  }

  parse(msg: AlertMessage): ParsedAlert | null {
    const m = msg.body.replace(/\s+/g, " ").trim().match(LINE);
    if (!m) return null;
    const money = parseMoney(m[3]);
    if (!money || money.minor <= 0n) return null;
    const type = /^credit$/i.test(m[1]) ? "CREDIT" : "DEBIT";
    const party = m[4].replace(/\|.*$/, "").trim().slice(0, 280);

    return {
      institution: this.institution,
      type,
      amountMinor: money.minor,
      currency: money.currency ?? "NGN",
      transactionDate: msg.receivedAt,
      description: party || `Providus ${type === "DEBIT" ? "debit" : "credit"}`,
      confidence: 0.4,
      autoPost: false,
    };
  }
}
