// Email body helpers shared by all bank parsers.

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&#8358;": "₦",
  "&naira;": "₦",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&[a-z]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? " ");
}

/**
 * Converts alert HTML into lines. Table rows become "cell : cell" so label/value
 * pairs laid out in two cells read the same as "Label: value" plaintext.
 */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(withBreaks)
    .split("\n")
    .map((line) =>
      line
        .split("\t")
        .map((c) => c.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" : ")
        .replace(/:(\s*:)+/g, ":"),
    )
    .filter(Boolean)
    .join("\n");
}

export function emailBodyText(email: { html?: string; text?: string }): string {
  const html = email.html ? htmlToText(email.html) : "";
  const text = email.text?.trim() ? decodeEntities(email.text).replace(/\r/g, "") : "";
  if (html && text) {
    if (html.includes(text)) return html;
    if (text.includes(html)) return text;
    // Yahoo (and others) send a short text/plain plus the real GeNS table in HTML.
    // Read the HTML first so labelled fields are not lost to the preview.
    return `${html}\n${text}`;
  }
  return html || text;
}

/** Extracts "Label : value" pairs. Keys are lowercased with collapsed whitespace. */
export function extractFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z .\/()]{0,40}?)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase().replace(/\s+/g, " ").trim();
    if (!fields.has(key)) fields.set(key, m[2]);
  }
  return fields;
}

export function pickField(fields: Map<string, string>, labels: string[]): string | undefined {
  for (const label of labels) {
    const v = fields.get(label);
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

const LAGOS_UTC_OFFSET_HOURS = 1; // Africa/Lagos, no DST

function lagosDate(y: number, mo: number, d: number, h = 12, mi = 0, s = 0): Date | undefined {
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return undefined;
  const date = new Date(Date.UTC(y, mo, d, h - LAGOS_UTC_OFFSET_HOURS, mi, s));
  // Reject rollovers like 31/02 by checking the Lagos-local calendar date survived
  const local = new Date(date.getTime() + LAGOS_UTC_OFFSET_HOURS * 3600_000);
  if (local.getUTCFullYear() !== y || local.getUTCMonth() !== mo || local.getUTCDate() !== d) return undefined;
  return date;
}

function parseTime(raw?: string): { h: number; m: number; s: number } | undefined {
  if (!raw) return undefined;
  const t = raw.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!t) return undefined;
  let h = parseInt(t[1], 10);
  const ampm = t[4]?.toUpperCase();
  if (ampm === "PM" && h < 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return { h, m: parseInt(t[2], 10), s: parseInt(t[3] ?? "0", 10) };
}

/**
 * Parses bank dates as Lagos local time. Nigerian banks use day-first numeric dates,
 * so 05/09/2026 is 5 September.
 */
export function parseBankDate(raw: string | undefined, timeRaw?: string): Date | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  const time = parseTime(timeRaw) ?? parseTime(s);
  const hms = time ? [time.h, time.m, time.s] as const : ([12, 0, 0] as const);
  const year = (y: string) => (y.length === 2 ? 2000 + parseInt(y, 10) : parseInt(y, 10));

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return lagosDate(+m[1], +m[2] - 1, +m[3], ...hms);

  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (m) return lagosDate(year(m[3]), +m[2] - 1, +m[1], ...hms);

  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3,9})[\s-,]*(\d{2,4})/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined)
    return lagosDate(year(m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1], ...hms);

  m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined)
    return lagosDate(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2], ...hms);

  return undefined;
}
