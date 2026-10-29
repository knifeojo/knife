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
    .replace(/&[a-z]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? " ")
    .replace(/[\u00a0\u2007\u202f]/g, " ");
}

/** Labels seen on GTBank GeNS (and similar) alert tables. Order is display order. */
export const ALERT_TABLE_LABELS = [
  "account number",
  "account no",
  "acct no",
  "account no.",
  "a/c number",
  "a/c no",
  "a/c",
  "acct",
  "account",
  "transaction location",
  "description",
  "narration",
  "narrative",
  "details",
  "transaction details",
  "tran particular",
  "txn particulars",
  "particulars",
  "payment details",
  "beneficiary",
  "beneficiary name",
  "merchant",
  "merchant name",
  "remarks",
  "remark",
  "amount",
  "transaction amount",
  "amt",
  "amount (ngn)",
  "value date",
  "transaction date",
  "txn date",
  "date of transaction",
  "posting date",
  "date",
  "time of transaction",
  "transaction time",
  "time",
  "document number",
  "reference",
  "reference number",
  "reference no",
  "ref",
  "ref no",
  "transaction reference",
  "session id",
  "available balance",
  "available bal",
  "avail bal",
  "avail. bal",
  "current balance",
  "cleared balance",
  "balance",
  "ledger balance",
  "transaction type",
  "txn type",
  "type",
  "dr/cr",
] as const;

const KNOWN_LABELS = new Set<string>(ALERT_TABLE_LABELS);

export function normalizeFieldLabel(raw: string): string {
  return decodeEntities(raw)
    .replace(/[:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isColonOnly(s: string): boolean {
  return /^[:.\s]*$/.test(s);
}

function looksLikeLabel(raw: string): boolean {
  return KNOWN_LABELS.has(normalizeFieldLabel(raw.split("\n")[0] ?? raw));
}

function cellText(html: string): string {
  const withBreaks = html
    .replace(/<(br|\/p|\/div)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withBreaks)
    .split(/\n+/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line && !isColonOnly(line))
    .join("\n");
}

function tableCells(row: string): string[] {
  const cells: string[] = [];
  const re = /<t[dh]\b[^>]*>([\s\S]*?)(?=<t[dh]\b|<\/t[dh]|<\/tr|$)/gi;
  for (const m of row.matchAll(re)) {
    const text = cellText(m[1]);
    if (text) cells.push(text);
  }
  return cells;
}

function pushCellLines(lines: string[], cell: string): void {
  for (const line of cell.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) lines.push(trimmed);
  }
}

function tableRows(table: string): string[] {
  return table.match(/<tr\b[^>]*>[\s\S]*?(?:<\/tr>|$)/gi) ?? [];
}

function setField(fields: Map<string, string>, rawKey: string, rawVal: string): void {
  const key = normalizeFieldLabel(rawKey);
  const val = rawVal.replace(/^[:.\s]+/, "").trim();
  if (!key || !val || fields.has(key)) return;
  fields.set(key, val);
}

/** Pair label/value cells in innermost tables, including label-then-next-row layouts. */
export function extractTableFields(html: string): Map<string, string> {
  const fields = new Map<string, string>();
  const tables = html.match(/<table\b[^>]*>(?:(?!<table\b)[\s\S])*?<\/table>/gi) ?? [];
  for (const table of tables) {
    let pending: string | undefined;
    for (const row of tableRows(table)) {
      const cells = tableCells(row);
      if (pending) {
        if (cells[0] && !looksLikeLabel(cells[0])) {
          setField(fields, pending, cells.join(" "));
          pending = undefined;
          continue;
        }
        pending = undefined;
      }
      if (cells.length >= 2 && looksLikeLabel(cells[0])) {
        setField(fields, cells[0], cells.slice(1).join(" "));
      } else if (cells.length === 1 && looksLikeLabel(cells[0])) {
        pending = cells[0];
      }
    }
  }
  return fields;
}

function tableToLines(tableHtml: string): string {
  const lines: string[] = [];
  let pending: string | undefined;
  for (const row of tableRows(tableHtml)) {
    const cells = tableCells(row);
    if (pending) {
      if (cells[0] && !looksLikeLabel(cells[0].split("\n")[0] ?? "")) {
        lines.push(`${pending} : ${cells.join(" : ").replace(/\n/g, " ")}`);
        pending = undefined;
        continue;
      }
      pending = undefined;
    }
    if (cells.some((c) => c.includes("\n"))) {
      for (const cell of cells) pushCellLines(lines, cell);
    } else if (cells.length >= 2) lines.push(cells.join(" : "));
    else if (cells.length === 1) {
      if (looksLikeLabel(cells[0])) pending = cells[0];
      else lines.push(cells[0]);
    }
  }
  if (pending) lines.push(pending);
  return lines.join("\n");
}

/**
 * Converts alert HTML into lines. Nested GeNS tables are flattened first so a label
 * in one inner table and its value in the next still become "Label : value".
 */
export function htmlToText(html: string): string {
  let s = html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "");
  for (let i = 0; i < 20; i++) {
    const next = s.replace(/<table\b[^>]*>(?:(?!<table\b)[\s\S])*?<\/table>/gi, (t) => `\n${tableToLines(t)}\n`);
    if (next === s) break;
    s = next;
  }
  const withBreaks = s
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

function bodyLines(text: string): string[] {
  return text
    .split(/\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Extracts "Label : value" pairs. Keys are lowercased with collapsed whitespace. */
export function extractFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of bodyLines(text)) {
    const m = line.match(/^([A-Za-z][A-Za-z .\/()]{0,40}?)\s*:\s*(.+)$/);
    if (!m) continue;
    setField(fields, m[1], m[2]);
  }
  return fields;
}

/** Known label on its own line (optional colon), value on the next non-empty line. */
export function extractAdjacentFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = bodyLines(text);
  for (let i = 0; i < lines.length; i++) {
    const key = normalizeFieldLabel(lines[i]);
    if (!KNOWN_LABELS.has(key)) continue;
    let j = i + 1;
    while (j < lines.length && isColonOnly(lines[j])) j++;
    if (j >= lines.length) continue;
    if (KNOWN_LABELS.has(normalizeFieldLabel(lines[j]))) continue;
    setField(fields, key, lines[j]);
  }
  return fields;
}

const INLINE_LABEL_RE = new RegExp(
  `(${[...ALERT_TABLE_LABELS].sort((a, b) => b.length - a.length).map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*:`,
  "gi",
);

/** Split a concatenated "Label : value Label : value" blob (nested tables collapsed to one line). */
export function extractInlineLabeledFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  INLINE_LABEL_RE.lastIndex = 0;
  const matches = [...text.matchAll(INLINE_LABEL_RE)];
  for (let i = 0; i < matches.length; i++) {
    const key = matches[i][1];
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    setField(fields, key, text.slice(start, end).replace(/\s+/g, " ").trim());
  }
  return fields;
}

function mergeFields(...maps: Map<string, string>[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const map of maps) {
    for (const [k, v] of map) setField(fields, k, v);
  }
  return fields;
}

/** Table cells first, then "Label : value" lines, then label-then-next-line text. */
export function extractAlertFields(email: { html?: string; text?: string }): Map<string, string> {
  const fromHtml = email.html ? extractTableFields(email.html) : new Map<string, string>();
  const body = emailBodyText(email);
  return mergeFields(fromHtml, extractFields(body), extractAdjacentFields(body), extractInlineLabeledFields(body));
}

function displayLabel(raw: string): string {
  return raw.replace(/[:]+$/g, "").replace(/\s+/g, " ").trim();
}

/** Ordered unique labels found in the email. Values are discarded. */
export function extractFieldLabels(email: { html?: string; text?: string }): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const n = normalizeFieldLabel(raw);
    if (!n || seen.has(n) || !KNOWN_LABELS.has(n)) return;
    seen.add(n);
    labels.push(displayLabel(raw));
  };
  if (email.html) {
    const tables = email.html.match(/<table\b[^>]*>(?:(?!<table\b)[\s\S])*?<\/table>/gi) ?? [];
    for (const table of tables) {
      for (const row of tableRows(table)) {
        const cells = tableCells(row);
        if (cells[0]) add(cells[0].split("\n")[0] ?? cells[0]);
      }
    }
  }
  const body = emailBodyText(email);
  for (const line of bodyLines(body)) {
    const m = line.match(/^([A-Za-z][A-Za-z .\/()]{0,40}?)\s*:/);
    if (m) add(m[1]);
    else if (KNOWN_LABELS.has(normalizeFieldLabel(line))) add(line);
  }
  INLINE_LABEL_RE.lastIndex = 0;
  for (const m of body.matchAll(INLINE_LABEL_RE)) add(m[1]);
  return labels;
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
