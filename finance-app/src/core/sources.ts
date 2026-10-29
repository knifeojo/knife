// Bank-specific search definitions. The sender domain has NOT been validated against a large
// sample of real GTBank alerts, so the query is deliberately broad and overridable per deployment.
// Statement emails are a second Gmail query (see statementGmailQuery). This alert query stays
// alert-only so it can still be tightened; it is not the only search a sync runs.

export interface BankEmailSource {
  institution: string;
  provider: "gmail";
  query: string;
  parser: string;
}

export const BANK_SOURCES: BankEmailSource[] = [
  {
    institution: "GTBank",
    provider: "gmail",
    query:
      process.env.GMAIL_QUERY_GTBANK ??
      '(from:gtbank.com OR from:gtco.com OR subject:GeNS) (subject:GeNS OR subject:"transaction alert" OR subject:debit OR subject:credit)',
    parser: "GTBankParser",
  },
];

/** First sync looks back this far; later syncs use the last-sync watermark. */
export const INITIAL_LOOKBACK_DAYS = 365;
/** IMAP listing page size. A first sync keeps paging via the UID checkpoint until it is caught up. */
export const MAX_MESSAGES_PER_SYNC = 1000;

/** Override with MAX_MESSAGES_PER_SYNC for tests. */
export function maxMessagesPerSync(): number {
  const n = Number(process.env.MAX_MESSAGES_PER_SYNC);
  return Number.isInteger(n) && n > 0 ? n : MAX_MESSAGES_PER_SYNC;
}
