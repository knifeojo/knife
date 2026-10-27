import { db } from "@/lib/db";
import { emailBodyText } from "../parsers/text";
import type { EmailMessage } from "../types";
import { isAllowedEmailSender } from "./senders";
import { storeAlertSample } from "./samples";

/** Email parse failure from a known bank sender → Review unparsed queue. */
export async function queueKnownUnparsed(userId: string, email: EmailMessage, parser?: string): Promise<void> {
  if (!isAllowedEmailSender(email.from)) return;
  const body = emailBodyText(email).slice(0, 4000);
  storeAlertSample({ userId, channel: "email", sender: email.from, parser, body });
  await db.unparsedAlert.create({
    data: {
      userId,
      channel: "email",
      sender: email.from.slice(0, 200),
      receivedAt: email.date,
      rawText: body || email.subject.slice(0, 400),
      reason: "unparsed",
      parser,
    },
  });
}
