import { getDocumentProxy } from "unpdf";
import { findColumns, isHeader, type Cell } from "./statements";

// Rebuilds the transaction table from a text-based (not scanned) PDF statement.
// 0. Map every text item into the page's displayed orientation (handles rotated/landscape pages,
//    e.g. FCMB e-statements, which are stored rotated 90 degrees with rotated text).
// 1. Group text items into lines by y position.
// 2. Find the header line (Date / Description / Debit+Credit or Amount), possibly split over two lines.
// 3. Use header cell positions as column anchors and drop every item into the nearest column.
// 4. Lines with no date and no amounts directly under a row are wrapped narration: append them.
// The output is plain rows, handed to the same parseStatementRows() as CSV and Excel.

export class PdfStatementError extends Error {
  constructor(message: string, readonly code: "password_required" | "password_incorrect" | "scanned" | "unreadable") {
    super(message);
  }
}

interface Item { str: string; x0: number; x1: number; y: number; size: number }
interface Line { y: number; size: number; items: Item[] }
interface Span { text: string; x0: number; x1: number }

type Matrix = [number, number, number, number, number, number];
const mul = (m1: Matrix, m2: Matrix): Matrix => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

interface PdfPageLike {
  getViewport(o: { scale: number }): { transform: number[]; height: number };
  getTextContent(): Promise<{ items: unknown[] }>;
}

/** Text items in upright display coordinates: x grows rightwards, y grows upwards. */
async function pageItems(page: PdfPageLike): Promise<Item[]> {
  const vp = page.getViewport({ scale: 1 });
  const { items } = await page.getTextContent();
  const out: Item[] = [];
  for (const raw of items as { str?: string; transform?: number[]; width?: number }[]) {
    if (!raw.str?.trim() || !raw.transform) continue;
    const m = mul(vp.transform as Matrix, raw.transform as Matrix);
    const size = Math.hypot(m[0], m[1]) || 8;
    // Text-space width scaled into device space along the (now horizontal) baseline.
    const scale = size / (Math.hypot(raw.transform[0], raw.transform[1]) || size);
    const x = m[4];
    out.push({ str: raw.str, x0: x, x1: x + (raw.width ?? 0) * scale, y: vp.height - m[5], size });
  }
  return out;
}

function toLines(its: Item[]): Line[] {
  its = [...its].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  // One transaction can be printed across stacked lines a few points apart (month/day, details and
  // amount, year). Group items into one line while each is within ~0.7 text heights of the lowest
  // item already in that line; separate transactions are a full line pitch or more apart.
  const lines: (Line & { minY: number })[] = [];
  for (const it of its) {
    const line = lines.find((l) => l.minY - it.y <= Math.max(2, Math.min(l.size, it.size) * 0.7) && l.y - it.y >= -2);
    if (line) {
      line.items.push(it);
      line.minY = Math.min(line.minY, it.y);
    } else lines.push({ y: it.y, size: it.size, items: [it], minY: it.y });
  }
  for (const l of lines) l.items.sort((a, b) => a.x0 - b.x0);
  return lines.sort((a, b) => b.y - a.y);
}

/** Merges items separated by less than ~one character into spans (words into phrases). */
function spans(items: Item[]): Span[] {
  const out: Span[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (prev && it.x0 - prev.x1 < it.size * 0.9) {
      prev.text = `${prev.text}${it.x0 - prev.x1 > it.size * 0.15 ? " " : ""}${it.str}`.replace(/\s+/g, " ");
      prev.x1 = Math.max(prev.x1, it.x1);
    } else out.push({ text: it.str.trim(), x0: it.x0, x1: it.x1 });
  }
  return out.map((s) => ({ ...s, text: s.text.trim() }));
}

/** Header split across two lines ("Value" over "Date"): merge spans that overlap horizontally. */
function mergeTwoLineHeader(a: Span[], b: Span[]): Span[] {
  const all = [...a, ...b].sort((p, q) => p.x0 - q.x0);
  const out: Span[] = [];
  for (const s of all) {
    const hit = out.find((o) => s.x0 < o.x1 && o.x0 < s.x1);
    if (hit) {
      hit.text = a.includes(s) ? `${s.text} ${hit.text}` : `${hit.text} ${s.text}`;
      hit.x0 = Math.min(hit.x0, s.x0);
      hit.x1 = Math.max(hit.x1, s.x1);
    } else out.push({ ...s });
  }
  return out.sort((p, q) => p.x0 - q.x0);
}

function findHeader(lines: Line[]): { index: number; consumed: number; cols: Span[] } | undefined {
  // Single-line headers first, so a preamble line is never glued onto a real header.
  for (let i = 0; i < lines.length; i++) {
    const one = spans(lines[i].items);
    if (isHeader(findColumns(one.map((s) => s.text)))) return { index: i, consumed: 1, cols: one };
  }
  for (let i = 0; i + 1 < lines.length; i++) {
    const two = mergeTwoLineHeader(spans(lines[i].items), spans(lines[i + 1].items));
    if (isHeader(findColumns(two.map((s) => s.text)))) return { index: i, consumed: 2, cols: two };
  }
  return undefined;
}

const DATE_LIKE = /\d{1,4}[\/\-. ](\d{1,2}|[A-Za-z]{3,9})[\/\-. ,]+\d{2,4}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4}/;
const MONEY_LIKE = /^(?=.*\d)[(\-]?\s*(NGN|₦|N)?\s*(\d{1,3}(,\d{3})*)?(\.\d{1,2})?\)?\s*(CR|DR)?$|^[(\-]?\d+\.\d{2}\)?$/i;

/** Midpoint-between-headings column bounds. Used to spot row lines before data-driven bands exist. */
function headerBounds(cols: Span[]) {
  return cols.map((c, i) => ({
    lo: i === 0 ? -Infinity : (cols[i - 1].x1 + c.x0) / 2,
    hi: i === cols.length - 1 ? Infinity : (c.x1 + cols[i + 1].x0) / 2,
  }));
}

type Assigner = (it: Item) => number;

function headerAssigner(cols: Span[]): Assigner {
  const b = headerBounds(cols);
  return (it) => {
    const center = (it.x0 + it.x1) / 2;
    const idx = b.findIndex((x) => center >= x.lo && center < x.hi);
    return idx >= 0 ? idx : cols.length - 1;
  };
}

/**
 * Column bands from the whitespace between data, not from heading positions. Headings are often
 * centred over wide columns (e.g. Remarks), which puts short values on the wrong side of a midpoint.
 */
function bandAssigner(rowLines: Line[], cols: Span[]): Assigner {
  const fallback = headerAssigner(cols);
  const intervals = rowLines.flatMap((l) => l.items.map((i) => [i.x0, i.x1] as [number, number])).sort((a, b) => a[0] - b[0]);
  if (intervals.length < 3) return fallback;
  const bands: [number, number][] = [];
  for (const [a, b] of intervals) {
    const last = bands[bands.length - 1];
    if (last && a <= last[1] + 1.5) last[1] = Math.max(last[1], b);
    else bands.push([a, b]);
  }
  const centers = cols.map((c) => (c.x0 + c.x1) / 2);
  const bandCol = bands.map(([lo, hi]) => {
    const inside = centers.map((c, i) => ({ c, i })).filter(({ c }) => c >= lo && c <= hi);
    if (inside.length === 1) return inside[0].i;
    if (inside.length > 1) return -1; // two headings share a band: fall back to midpoints there
    const mid = (lo + hi) / 2;
    return centers.reduce((best, c, i) => (Math.abs(c - mid) < Math.abs(centers[best] - mid) ? i : best), 0);
  });
  // A heading with no band of its own would swallow nothing; if two bands map to one heading that is fine.
  return (it) => {
    const center = (it.x0 + it.x1) / 2;
    const k = bands.findIndex(([lo, hi]) => center >= lo - 0.5 && center <= hi + 0.5);
    if (k < 0 || bandCol[k] < 0) return fallback(it);
    return bandCol[k];
  };
}

function cellsOf(items: Item[], n: number, assign: Assigner): string[] {
  const cells: string[][] = Array.from({ length: n }, () => []);
  for (const it of items) cells[assign(it)].push(it.str);
  return cells.map((c) => c.join(" ").replace(/\s+/g, " ").trim());
}

/** Groups body lines into one block per transaction using line spacing. Returns undefined if spacing is irregular. */
function groupIntoRowBlocks(
  body: Line[],
  isRow: (l: Line) => boolean,
  cellsFor: (l: Line) => string[],
  descIdx: number | undefined,
): { rows: string[][]; other: string[]; carriedOver: string[] } | undefined {
  if (descIdx === undefined || body.length < 6) return undefined;
  const gaps = body.slice(1).map((l, i) => Math.round((body[i].y - l.y) * 2) / 2);
  const size = body[0].size || 8;
  // Line pitch: the most common gap between 0.8 and 1.6 text heights.
  const counts = new Map<number, number>();
  for (const g of gaps) if (g >= size * 0.8 && g <= size * 1.6) counts.set(g, (counts.get(g) ?? 0) + 1);
  const pitch = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  if (!pitch) return undefined;
  const wrapped = gaps.filter((g) => Math.abs(g - pitch) <= 0.6).length;
  const separators = gaps.filter((g) => g > pitch * 1.25).length;
  // Only trust this when the statement really has both tight wrapped lines and wider row gaps.
  if (wrapped < 3 || separators < 2) return undefined;

  const blocks: Line[][] = [[body[0]]];
  for (let i = 1; i < body.length; i++) {
    if (body[i - 1].y - body[i].y > pitch * 1.25) blocks.push([]);
    blocks[blocks.length - 1].push(body[i]);
  }
  const rows: string[][] = [];
  const other: string[] = [];
  const carriedOver: string[] = [];
  for (const [bi, block] of blocks.entries()) {
    const rowLines = block.filter(isRow);
    if (!rowLines.length) {
      // Remark lines at the very top of a page, before its first transaction, finish the last
      // transaction of the previous page (a remark split by a page break).
      const descOnly = block.every((l) => cellsFor(l).every((c, i) => !c || i === descIdx));
      if (bi === 0 && descOnly) carriedOver.push(...block.map((l) => cellsFor(l)[descIdx]));
      else other.push(...block.map((l) => cellsFor(l).filter(Boolean).join(" ")));
      continue;
    }
    const built = rowLines.map((l) => ({ y: l.y, cells: cellsFor(l), before: [] as string[], after: [] as string[] }));
    for (const l of block) {
      if (rowLines.includes(l)) continue;
      const cells = cellsFor(l);
      const descOnly = cells.every((c, i) => !c || i === descIdx);
      if (!descOnly) {
        other.push(cells.filter(Boolean).join(" "));
        continue;
      }
      // Nearest row line within the block (usually the only one)
      const target = built.reduce((best, r) => (Math.abs(r.y - l.y) < Math.abs(best.y - l.y) ? r : best), built[0]);
      (l.y > target.y ? target.before : target.after).push(cells[descIdx]);
    }
    for (const r of built) {
      r.cells[descIdx] = [...r.before, r.cells[descIdx], ...r.after].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
      rows.push(r.cells);
    }
  }
  return { rows, other, carriedOver };
}

export interface PdfSection {
  rows: Cell[][];
  otherText: string;
}

async function loadPageItems(bytes: Buffer, password?: string): Promise<Item[][]> {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes), password ? { password } : {});
  } catch (e) {
    const err = e as { name?: string; code?: number };
    if (err?.name === "PasswordException") {
      throw err.code === 2
        ? new PdfStatementError("Wrong password for this PDF.", "password_incorrect")
        : new PdfStatementError("This PDF is password-protected. Enter the statement password and upload again.", "password_required");
    }
    throw new PdfStatementError("Could not open this PDF. It may be damaged.", "unreadable");
  }
  const pages: Item[][] = [];
  for (let n = 1; n <= pdf.numPages; n++) pages.push(await pageItems((await pdf.getPage(n)) as unknown as PdfPageLike));
  if (!pages.some((page) => page.length)) {
    throw new PdfStatementError("This PDF has no readable text (it looks scanned). Download the e-statement from your bank app or internet banking instead.", "scanned");
  }
  return pages;
}

/** Reading-order text, one visual line per row. Formats that wrap mid-cell (Pesa) parse this directly. */
export async function pdfToPlainText(bytes: Buffer, password?: string): Promise<string> {
  const pages = await loadPageItems(bytes, password);
  return pages
    .map((items) => toLines(items).map((l) => spans(l.items).map((s) => s.text).filter(Boolean).join(" ")).join("\n"))
    .join("\n");
}

/**
 * Rebuilds statement tables. One PDF can hold several accounts (e.g. a current account followed by a
 * savings account): a page that restates an account header for a different account starts a new section.
 */
export async function pdfToSections(bytes: Buffer, password?: string): Promise<PdfSection[]> {
  const pages = await loadPageItems(bytes, password);

  const sections: { rows: Cell[][]; other: string[]; account?: string }[] = [];
  let current: (typeof sections)[number] | undefined;
  let cols: Span[] | undefined;
  let colIdx: ReturnType<typeof findColumns> = {};
  let pendingPreamble: Cell[][] = [];

  for (const pageItems of pages) {
    const lines = toLines(pageItems);
    const header = findHeader(lines);
    let start = 0;
    if (header) {
      const preamble = lines.slice(0, header.index).map((l) => spans(l.items).map((s) => s.text) as Cell[]);
      const account = accountKeyFrom([...pendingPreamble, ...preamble]);
      const restatesAccount = preamble.some((r) => r.some((c) => /account\s*(no|number|type)|opening balance/i.test(String(c))));
      if (!current || (restatesAccount && account && account !== current.account)) {
        current = { rows: [...pendingPreamble, ...preamble], other: [], account };
        current.rows.push(header.cols.map((c) => c.text));
        sections.push(current);
      }
      pendingPreamble = [];
      cols = header.cols;
      colIdx = findColumns(cols.map((c) => c.text));
      start = header.index + header.consumed;
    } else if (!cols || !current) {
      // Page before any table (cover page): keep as preamble for bank/account detection.
      pendingPreamble.push(...lines.map((l) => spans(l.items).map((s) => s.text) as Cell[]));
      continue;
    }

    const body = lines.slice(start);
    const amountCols = [colIdx.debit, colIdx.credit, colIdx.amount, colIdx.balance].filter((v): v is number => v !== undefined);
    const byHeader = headerAssigner(cols);
    const isRowLine = (l: Line) => {
      const cells = cellsOf(l.items, cols!.length, byHeader);
      return (colIdx.date !== undefined && DATE_LIKE.test(cells[colIdx.date])) || amountCols.some((i) => MONEY_LIKE.test(cells[i].trim()));
    };
    const assign = bandAssigner(body.filter(isRowLine), cols);
    const descIdx = colIdx.description;

    type Pending = { y: number; text: string; size: number };
    let pending: Pending[] = [];
    let prevRow: { cells: string[]; y: number } | undefined;
    const appendTo = (cells: string[], text: string) => {
      if (descIdx === undefined) return;
      cells[descIdx] = `${cells[descIdx]} ${text}`.replace(/\s+/g, " ").trim();
    };
    /** Trailing narration lines with no row below them: attach to the row above if close, else footer. */
    const flushPending = () => {
      for (const p of pending.sort((x, y) => y.y - x.y)) {
        if (prevRow && prevRow.y - p.y < p.size * 2.6) appendTo(prevRow.cells, p.text);
        else current!.other.push(p.text);
      }
      pending = [];
    };

    // Preferred: group lines into row blocks by spacing. Wrapped remark lines are one line-pitch apart;
    // rows are separated by a larger gap. Each block holds one dated/amount line, and every remark line
    // in the block belongs to it, whether printed above, on, or below the date line.
    const other_push = (xs: string[]) => current!.other.push(...xs);
    const blockRows = groupIntoRowBlocks(body, isRowLine, (l) => cellsOf(l.items, cols!.length, assign), descIdx);
    if (blockRows) {
      const last = current!.rows[current!.rows.length - 1];
      if (blockRows.carriedOver.length && last && descIdx !== undefined && last.length === cols.length && current!.rows.length > 1) {
        last[descIdx] = [String(last[descIdx] ?? ""), ...blockRows.carriedOver].join(" ").replace(/\s+/g, " ").trim();
      } else other_push(blockRows.carriedOver);
      current!.rows.push(...blockRows.rows);
      current!.other.push(...blockRows.other);
      continue;
    }

    // Fallback when the spacing is irregular. How does this statement wrap long remarks? Top-aligned tables (GTBank) start the remark on the
    // date line and continue BELOW it, so every wrapped line belongs to the row above, however long.
    // Centred tables put wrapped lines around the date line, so they go to the nearest row.
    const rowLines = body.filter(isRowLine);
    const withText = descIdx === undefined ? 0 : rowLines.filter((l) => cellsOf(l.items, cols!.length, assign)[descIdx]).length;
    const topAligned = rowLines.length > 0 && withText / rowLines.length >= 0.6;
    let lastY: number | undefined;
    let carry: string[] = []; // text that belongs to the NEXT row (printed just above its date line)

    for (let li = 0; li < body.length; li++) {
      const l = body[li];
      const cells = cellsOf(l.items, cols.length, assign);
      const hasDate = colIdx.date !== undefined && DATE_LIKE.test(cells[colIdx.date]);
      const hasAmount = amountCols.some((i) => MONEY_LIKE.test(cells[i].trim()));
      if (topAligned) {
        if (hasDate || hasAmount) {
          if (carry.length && descIdx !== undefined) cells[descIdx] = [...carry, cells[descIdx]].join(" ").replace(/\s+/g, " ").trim();
          carry = [];
          current!.rows.push(cells);
          prevRow = { cells, y: l.y };
          lastY = l.y;
          continue;
        }
        const descOnly = descIdx !== undefined && cells.every((c, i) => !c || i === descIdx);
        // Some rows print their first remark line a few points ABOVE the date line: if the next line is
        // a row and this line is closer to it than to the line above, it starts that next row's remark.
        const next = body[li + 1];
        if (descOnly && next && isRowLine(next) && l.y - next.y < (lastY !== undefined ? lastY - l.y : Infinity) && l.y - next.y <= l.size * 0.9) {
          carry.push(cells[descIdx!]);
          continue;
        }
        // A wrapped line sits within ~2 line-heights of the line above it; footers are further away.
        if (descOnly && prevRow && lastY !== undefined && lastY - l.y <= l.size * 2.4) {
          appendTo(prevRow.cells, cells[descIdx!]);
          lastY = l.y;
        } else current!.other.push(cells.filter(Boolean).join(" "));
        continue;
      }
      if (hasDate || hasAmount) {
        // Narration lines between two rows go to whichever row's date line they sit nearer to.
        const above: string[] = [];
        for (const p of pending.sort((x, y) => y.y - x.y)) {
          const gapPrev = prevRow ? prevRow.y - p.y : Infinity;
          if (p.y - l.y <= gapPrev) above.push(p.text);
          else if (prevRow) appendTo(prevRow.cells, p.text);
          else current!.other.push(p.text);
        }
        pending = [];
        if (above.length && descIdx !== undefined) cells[descIdx] = [...above, cells[descIdx]].join(" ").replace(/\s+/g, " ").trim();
        current!.rows.push(cells);
        prevRow = { cells, y: l.y };
        continue;
      }
      // Continuation text must sit only in the description column; page footers span other columns.
      const onlyDescription = descIdx !== undefined && cells.every((c, i) => !c || i === descIdx);
      if (onlyDescription) pending.push({ y: l.y, text: cells[descIdx!], size: l.size });
      else {
        flushPending();
        current!.other.push(cells.filter(Boolean).join(" "));
      }
    }
    flushPending();
  }
  return sections.map((s) => ({ rows: s.rows, otherText: s.other.join("\n") }));
}

function accountKeyFrom(preamble: Cell[][]): string | undefined {
  for (const row of preamble) {
    for (let i = 0; i < row.length; i++) {
      if (!/account\s*(no|number|num)/i.test(String(row[i] ?? ""))) continue;
      const v = [String(row[i]).split(":")[1], row[i + 1], row[i + 2]].map((x) => String(x ?? "").replace(/\s+/g, "")).find((x) => /\d{3,}/.test(x));
      if (v) return v;
    }
  }
  return undefined;
}

/** Single-account convenience: the first section, plus footer text from every section. */
export async function pdfToTable(bytes: Buffer, password?: string): Promise<PdfSection> {
  const sections = await pdfToSections(bytes, password);
  return { rows: sections[0]?.rows ?? [], otherText: sections.map((s) => s.otherText).join("\n") };
}

export async function pdfToRows(bytes: Buffer, password?: string): Promise<Cell[][]> {
  return (await pdfToTable(bytes, password)).rows;
}
