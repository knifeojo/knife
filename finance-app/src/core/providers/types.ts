import type { CanonicalTransaction, EmailMessage, SourceType } from "../types";

/** Email-based sources (Gmail today, Outlook later, fixtures in dev/tests). */
export interface EmailSource {
  readonly source: SourceType;
  listMessageIds(opts: { query: string; after?: Date; max?: number }): Promise<string[]>;
  getMessage(id: string): Promise<EmailMessage>;
  listHistoryMessageIds?(startHistoryId: string): Promise<{ ids: string[]; historyId?: string; stale?: boolean }>;
}

// Future structured providers (Mono, statements, SMS) implement this and feed the same ledger
// through ingestTransaction(). Not implemented in the MVP.
export interface Account {
  id: string;
  institution: string;
  maskedAccountNumber: string;
  currency: string;
}
export interface Balance {
  accountId: string;
  availableMinor: bigint;
  currency: string;
  asOf: Date;
}
export interface FinancialDataProvider {
  readonly source: SourceType;
  getAccounts(): Promise<Account[]>;
  getTransactions(accountId: string, from: Date, to: Date): Promise<CanonicalTransaction[]>;
  getBalance(accountId: string): Promise<Balance>;
}
