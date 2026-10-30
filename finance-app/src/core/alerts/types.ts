import type { ParsedTransaction, TransactionType } from "../types";

export type AlertChannel = "email" | "sms" | "push";

/** A bank alert as handed to the shared registry. Bodies live in memory only. */
export interface AlertMessage {
  channel: AlertChannel;
  sender: string;
  subject?: string;
  body: string;
  receivedAt: Date;
  id?: string;
}

export interface ParsedAlert extends ParsedTransaction {
  /** False for fallback / stub matches: they go to Review, they are not posted. */
  autoPost: boolean;
}

export interface AlertParser {
  readonly name: string;
  readonly institution: string;
  readonly channels: readonly AlertChannel[];
  /** SMS sender IDs or email domains/addresses this parser claims. Compared case-insensitively. */
  readonly senders: readonly string[];
  /** When true, canParse always returns false until a real sample lands. Tests assert the stub exists. */
  readonly stub?: boolean;
  canParse(msg: AlertMessage): boolean;
  parse(msg: AlertMessage): ParsedAlert | null;
}

export type ParseAlertOutcome =
  | { status: "parsed"; parser: string; transaction: ParsedAlert }
  | { status: "review"; parser: string; transaction: ParsedAlert }
  | { status: "failed"; parser: string }
  | { status: "unparsed"; reason: "known_sender" }
  | { status: "skipped" };

export const ALERT_SOURCE_TYPES = ["gmail", "imap", "inbound", "sms", "push", "fixture"] as const;
export type AlertSourceType = (typeof ALERT_SOURCE_TYPES)[number];

export function isFeeNarration(description: string): boolean {
  return /commission on nip|stamp duty|electronic money transfer levy|\bemtl\b|\bvat\b|sms (alert )?charge|nip charge|transfer (charge|levy)|alert charge|card maint|maintenance fee|\bcot\b/i.test(
    description,
  );
}

export function signedAmount(type: TransactionType, amountMinor: bigint): bigint {
  return type === "CREDIT" ? amountMinor : -amountMinor;
}
