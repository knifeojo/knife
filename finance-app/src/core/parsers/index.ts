import type { BankAlertParser, EmailMessage, ParsedTransaction } from "../types";
import { GTBankParser } from "./gtbank";

// Register new banks here (AccessBankParser, ZenithParser, UBAParser, ...).
export const PARSERS: BankAlertParser[] = [new GTBankParser()];

export type ParseOutcome =
  | { status: "parsed"; parser: string; transaction: ParsedTransaction }
  | { status: "skipped" } // no parser recognised the email
  | { status: "failed"; parser: string }; // recognised but could not extract a transaction

export function parseEmail(email: EmailMessage, parsers: BankAlertParser[] = PARSERS): ParseOutcome {
  for (const parser of parsers) {
    if (!parser.canParse(email)) continue;
    try {
      const tx = parser.parse(email);
      return tx ? { status: "parsed", parser: parser.name, transaction: tx } : { status: "failed", parser: parser.name };
    } catch {
      return { status: "failed", parser: parser.name };
    }
  }
  return { status: "skipped" };
}
