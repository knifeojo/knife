// Bank-specific search definitions. The sender domain has NOT been validated against a large
// sample of real GTBank alerts, so the query is deliberately broad and overridable per deployment.

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
/** Hard cap per sync run so a first sync cannot run away. */
export const MAX_MESSAGES_PER_SYNC = 1000;
