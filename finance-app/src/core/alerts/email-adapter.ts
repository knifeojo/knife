import { emailBodyText } from "../parsers/text";
import { GTBankParser } from "../parsers/gtbank";
import type { EmailMessage } from "../types";
import type { AlertMessage, AlertParser, ParsedAlert } from "./types";

export function emailToAlert(email: EmailMessage): AlertMessage {
  return {
    channel: "email",
    sender: email.from,
    subject: email.subject,
    body: emailBodyText(email),
    receivedAt: email.date,
    id: email.id,
  };
}

/** Wraps the existing HTML-aware GTBank email parser so the registry stays one place. */
export class GTBankEmailParser implements AlertParser {
  readonly name = "GTBankParser";
  readonly institution = "GTBank";
  readonly channels = ["email"] as const;
  readonly senders = ["gtbank.com", "gtco.com"];
  private readonly inner = new GTBankParser();

  canParse(msg: AlertMessage): boolean {
    if (msg.channel !== "email") return false;
    return this.inner.canParse({
      id: msg.id ?? "",
      from: msg.sender,
      subject: msg.subject ?? "",
      date: msg.receivedAt,
      text: msg.body,
    });
  }

  parse(msg: AlertMessage): ParsedAlert | null {
    const tx = this.inner.parse({
      id: msg.id ?? "",
      from: msg.sender,
      subject: msg.subject ?? "",
      date: msg.receivedAt,
      text: msg.body,
    });
    if (!tx) return null;
    return { ...tx, autoPost: tx.confidence >= 0.75 };
  }
}
