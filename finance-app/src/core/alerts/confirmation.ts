/** Detects Gmail's "please confirm forwarding" mail so the owner can finish setup in the app. */

const CODE = /(?:confirmation code|confirmation number|code is)\s*[:\s]*([0-9]{6,12})/i;
const LINK = /https?:\/\/mail\.google\.com\/mail\/[^\s"'<>]+/i;
const SUBJECT = /gmail forwarding confirmation|forwarding confirmation/i;

export interface ForwardingConfirmation {
  code?: string;
  link?: string;
}

export function detectGmailForwardingConfirmation(input: {
  subject?: string;
  text?: string;
  html?: string;
}): ForwardingConfirmation | null {
  const subject = input.subject ?? "";
  const body = `${input.text ?? ""}\n${input.html ?? ""}`;
  const looksLike = SUBJECT.test(subject) || /Gmail Forwarding Confirmation|forwarding of mail from/i.test(body);
  if (!looksLike) return null;
  const code = body.match(CODE)?.[1];
  const link = body.match(LINK)?.[0];
  if (!code && !link && !SUBJECT.test(subject)) return null;
  return { code, link };
}
