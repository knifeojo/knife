// Canonical types shared by every ingestion source (email, statement, open banking, SMS).

export type TransactionType = "CREDIT" | "DEBIT";
// Extensible later: "TRANSFER" | "REVERSAL" | "REFUND" | "FEE" | "UNKNOWN"

export type SourceType = "gmail" | "fixture" | "demo" | "statement" | "mono" | "sms" | "manual";

/** A raw email as handed to parsers. Bodies live in memory only and are never persisted. */
export interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  date: Date;
  html?: string;
  text?: string;
}

/** Output of a bank parser. Amounts are integer minor units (kobo). */
export interface ParsedTransaction {
  institution: string;
  type: TransactionType;
  amountMinor: bigint;
  currency: string;
  transactionDate: Date;
  description: string;
  reference?: string;
  balanceAfterMinor?: bigint;
  accountLast4?: string;
  /** Account holder's name when the source states or implies it (statements). */
  accountHolder?: string;
  /**
   * Settlement quoted by the source in another currency. A Deel withdrawal of USD 1,250
   * at an NGN exchange rate stores the naira proceeds here so FX learning does not have
   * to wait for the matching bank credit.
   */
  fxQuoteCurrency?: string;
  fxQuoteMinor?: bigint;
  /** 0..1, how many expected fields the parser found */
  confidence: number;
}

/** What every source must produce before dedup + persistence. */
export interface CanonicalTransaction extends ParsedTransaction {
  source: SourceType;
  sourceTransactionId: string;
}

export interface Classification {
  category: string;
  subcategory?: string;
  merchantName?: string;
  counterparty?: string;
  source: "rule" | "user" | "ai" | "default";
  confidence: number;
  /** The known person on the other side, when the name matched one confidently. */
  personId?: string;
}

export interface BankAlertParser {
  readonly name: string;
  readonly institution: string;
  canParse(email: EmailMessage): boolean;
  parse(email: EmailMessage): ParsedTransaction | null;
}
