import { parseEmail } from "../parsers";
import { extractFieldLabels } from "../parsers/text";
import type { EmailMessage } from "../types";

/** Digits in subjects are amounts or dates; replace them so a fingerprint carries no values. */
export function maskSubjectDigits(subject: string): string {
  return subject.replace(/\d/g, "#");
}

export interface AlertFingerprint {
  subject: string;
  sender: string;
  labels: string[];
}

export function alertFingerprint(email: EmailMessage): AlertFingerprint {
  return {
    subject: maskSubjectDigits(email.subject),
    sender: email.from,
    labels: extractFieldLabels(email),
  };
}

/** One failed email: subject pattern, sender, ordered labels. No values. */
export function formatAlertFingerprint(fp: AlertFingerprint): string {
  const labels = fp.labels.length ? fp.labels.join(" | ") : "(none)";
  return `${fp.subject}\t${fp.sender}\t${labels}`;
}

export function diagnoseFailedEmail(email: EmailMessage): string | null {
  const outcome = parseEmail(email);
  if (outcome.status !== "failed") return null;
  return formatAlertFingerprint(alertFingerprint(email));
}
