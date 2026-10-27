import type { EmailMessage } from "../types";

/** Split a classic mbox (messages start with "From "). Bodies stay in memory. */
export function parseMbox(raw: string, max = 2000): EmailMessage[] {
  const chunks = raw.replace(/\r\n/g, "\n").split(/^From .+\n/m).filter((c) => c.trim());
  const out: EmailMessage[] = [];
  for (const chunk of chunks.slice(0, max)) {
    const parsed = parseRfc822(chunk);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseRfc822(raw: string, id?: string): EmailMessage | null {
  const split = raw.indexOf("\n\n");
  const head = split >= 0 ? raw.slice(0, split) : raw;
  const body = split >= 0 ? raw.slice(split + 2) : "";
  const headers: Record<string, string> = {};
  let current = "";
  for (const line of head.split("\n")) {
    if (/^\s/.test(line) && current) {
      headers[current] += " " + line.trim();
      continue;
    }
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    current = m[1].toLowerCase();
    headers[current] = m[2];
  }
  const from = headers.from;
  if (!from) return null;
  const date = headers.date ? new Date(headers.date) : new Date();
  const ct = headers["content-type"] ?? "";
  const html = /text\/html/i.test(ct) ? body : undefined;
  const text = html ? undefined : body;
  return {
    id: id ?? headers["message-id"] ?? `mbox-${outHash(from, headers.subject ?? "", date.toISOString())}`,
    from,
    subject: headers.subject ?? "",
    date: Number.isNaN(date.getTime()) ? new Date() : date,
    text,
    html,
  };
}

function outHash(from: string, subject: string, date: string): string {
  let h = 0;
  const s = `${from}|${subject}|${date}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
