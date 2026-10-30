// Known bank SMS sender IDs and email domains. Personal numbers and telco/promo
// senders are never read or uploaded. Extra IDs can be added with SMS_SENDERS (comma-separated).

export interface KnownSender {
  id: string;
  institution: string;
  channel: "sms" | "email" | "both";
}

export const BANK_SENDERS: KnownSender[] = [
  { id: "GTBank", institution: "GTBank", channel: "sms" },
  { id: "GTWorld", institution: "GTBank", channel: "sms" },
  { id: "FirstBank", institution: "First Bank", channel: "sms" },
  { id: "STERLING", institution: "Sterling Bank", channel: "sms" },
  { id: "Sterling", institution: "Sterling Bank", channel: "sms" },
  { id: "PROVIDUS", institution: "Providus Bank", channel: "sms" },
  { id: "gtbank.com", institution: "GTBank", channel: "email" },
  { id: "gtco.com", institution: "GTBank", channel: "email" },
  { id: "firstbanknigeria.com", institution: "First Bank", channel: "email" },
  { id: "firstbank.com", institution: "First Bank", channel: "email" },
  { id: "sterling.ng", institution: "Sterling Bank", channel: "email" },
  { id: "sterlingbankng.com", institution: "Sterling Bank", channel: "email" },
  { id: "providusbank.com", institution: "Providus Bank", channel: "email" },
];

/** Telco shortcodes, promo IDs and anything that is not a bank. */
const BLOCKED = /^(303|glodatasale|glo-roam|glo|video|getmigo|myd ?alert|mtn|airtel|9mobile|naija|promo)$/i;

export function extraSmsSenders(): string[] {
  return (process.env.SMS_SENDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isPhoneSender(sender: string): boolean {
  return /^\+?\d{8,15}$/.test(sender.replace(/[\s()-]/g, ""));
}

export function normalizeSender(sender: string): string {
  const angle = sender.match(/<([^>]+)>/);
  return (angle ? angle[1] : sender).trim();
}

export function senderDomain(sender: string): string {
  const email = normalizeSender(sender);
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : email.toLowerCase();
}

function extraMatches(sender: string): boolean {
  const n = normalizeSender(sender).toLowerCase();
  return extraSmsSenders().some((s) => s.toLowerCase() === n);
}

export function isBlockedSmsSender(sender: string): boolean {
  return BLOCKED.test(normalizeSender(sender));
}

/**
 * Phone numbers and telco ids never enter ingest. Any other sender may: known banks
 * use their parser, and an unknown financial sender falls through to the generic parser (Review).
 */
export function isIngestibleSmsSender(sender: string): boolean {
  const n = normalizeSender(sender);
  if (!n || isPhoneSender(n) || isBlockedSmsSender(n)) return false;
  return true;
}

/** One-time codes are not transactions, even from a known bank. */
export function isOtpMessage(body: string, subject = ""): boolean {
  const text = `${subject}\n${body}`;
  return /\b(otp|one[-\s]?time (?:password|pin|code)|verification code|do not share(?: this)? (?:code|otp)|your code is)\b/i.test(text) ||
    /\b(?:code|otp)\s*(?:is|:)\s*\d{4,8}\b/i.test(text);
}

/** SMS: alphanumeric bank sender IDs only. Phone numbers and telco/promo IDs are refused. */
export function isAllowedSmsSender(sender: string): boolean {
  const n = normalizeSender(sender);
  if (!n || isPhoneSender(n) || BLOCKED.test(n)) return false;
  if (extraMatches(n)) return true;
  return BANK_SENDERS.some((s) => s.channel !== "email" && s.id.toLowerCase() === n.toLowerCase());
}

/** Email: known bank domains (and extra SMS_SENDERS is ignored here). */
export function isAllowedEmailSender(sender: string): boolean {
  const domain = senderDomain(sender);
  if (!domain || BLOCKED.test(domain)) return false;
  return BANK_SENDERS.some((s) => s.channel !== "sms" && (s.id.toLowerCase() === domain || domain.endsWith(`.${s.id.toLowerCase()}`)));
}

export function isKnownBankSender(sender: string, channel: "email" | "sms"): boolean {
  return channel === "sms" ? isAllowedSmsSender(sender) : isAllowedEmailSender(sender);
}

export function institutionForSender(sender: string): string | undefined {
  const n = normalizeSender(sender);
  const domain = senderDomain(sender);
  const hit = BANK_SENDERS.find(
    (s) => s.id.toLowerCase() === n.toLowerCase() || s.id.toLowerCase() === domain || domain.endsWith(`.${s.id.toLowerCase()}`),
  );
  return hit?.institution;
}

export function smsSenderIds(): string[] {
  const ids = BANK_SENDERS.filter((s) => s.channel !== "email").map((s) => s.id);
  return [...new Set([...ids, ...extraSmsSenders()])];
}

/** Marketing / non-transaction copy from a bank sender: skip, do not queue as unparsed. */
export function isBankMarketing(body: string, subject = ""): boolean {
  const text = `${subject}\n${body}`;
  return /congratulations! you have a loan offer|alwayson overdraft|keep transacting|dial \*\d/i.test(text) &&
    !/\b(amt|amount|debit|credit|money (in|out)|you have spent|has arrived)\b/i.test(text);
}
