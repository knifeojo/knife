import type { CanonicalTransaction, EmailMessage, SourceType } from "../types";

export type ImapFolderCursorMap = Record<string, { uid: number; uidValidity?: string | null }>;

/** Email-based sources (Gmail today, Outlook later, fixtures in dev/tests). */
export interface EmailSource {
  readonly source: SourceType;
  listMessageIds(opts: { query: string; after?: Date; max?: number; folderCursors?: ImapFolderCursorMap }): Promise<string[]>;
  getMessage(id: string): Promise<EmailMessage>;
  /** Gmail stores large attachments separately. Other sources put bytes on the message. */
  fetchAttachment?(messageId: string, attachmentId: string): Promise<Buffer>;
  listHistoryMessageIds?(startHistoryId: string): Promise<{ ids: string[]; historyId?: string; stale?: boolean }>;
  /** Keep one IMAP connection across list + fetch. No-op for Gmail and fixtures. */
  beginSession?(): Promise<void>;
  endSession?(): Promise<void>;
  /** Folder UIDVALIDITY seen while listing, used to reset a stale IMAP checkpoint. */
  folderUidValidity?(folder: string): string | undefined;
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
