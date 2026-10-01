import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

// Builds a synthetic GTBank-style PDF statement: preamble, table with right-aligned amounts,
// a narration that wraps onto a second line, page footer, and the header repeated on page 2.

const COLS = { date: 40, ref: 110, value: 210, debit: 330, credit: 400, balance: 470, remarks: 520 };
type Row = { date: string; ref: string; debit?: string; credit?: string; balance: string; remarks: string[] };

function right(page: PDFPage, font: PDFFont, text: string, rightX: number, y: number) {
  page.drawText(text, { x: rightX - font.widthOfTextAtSize(text, 8), y, size: 8, font });
}

function drawHeader(page: PDFPage, bold: PDFFont, y: number, twoLine = false) {
  const t = (s: string, x: number, yy = y) => page.drawText(s, { x, y: yy, size: 8, font: bold });
  if (twoLine) {
    t("Trans.", COLS.date); t("Date", COLS.date, y - 10);
    t("Reference", COLS.ref);
    t("Value", COLS.value); t("Date", COLS.value, y - 10);
  } else {
    t("Trans. Date", COLS.date); t("Reference", COLS.ref); t("Value. Date", COLS.value);
  }
  t("Debits", COLS.debit + 20); t("Credits", COLS.credit + 20); t("Balance", COLS.balance + 15); t("Remarks", COLS.remarks + 20);
}

export async function makeStatementPdf(pages: Row[][], opts: { twoLineHeader?: boolean } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  pages.forEach((rows, p) => {
    const page = doc.addPage([842, 595]);
    let y = 560;
    if (p === 0) {
      page.drawText("Guaranty Trust Bank Plc", { x: 40, y, size: 12, font: bold });
      page.drawText("Account No: 0123454521", { x: 40, y: y - 16, size: 9, font });
      page.drawText("Currency: NGN", { x: 40, y: y - 28, size: 9, font });
      y -= 60;
    }
    drawHeader(page, bold, y, opts.twoLineHeader);
    y -= opts.twoLineHeader ? 26 : 16;
    for (const r of rows) {
      page.drawText(r.date, { x: COLS.date, y, size: 8, font });
      page.drawText(r.ref, { x: COLS.ref, y, size: 8, font });
      page.drawText(r.date, { x: COLS.value, y, size: 8, font });
      if (r.debit) right(page, font, r.debit, COLS.debit + 50, y);
      if (r.credit) right(page, font, r.credit, COLS.credit + 55, y);
      right(page, font, r.balance, COLS.balance + 50, y);
      r.remarks.forEach((line, i) => page.drawText(line, { x: COLS.remarks + 20, y: y - i * 9, size: 8, font }));
      y -= 9 * r.remarks.length + 6;
    }
    page.drawText(`Page ${p + 1} of ${pages.length}`, { x: 400, y: 30, size: 8, font });
  });
  return Buffer.from(await doc.save());
}

export const PAGE1: Row[] = [
  { date: "16-Sep-2026", ref: "WEB260916120301", debit: "18,450.00", balance: "2,211,389.50", remarks: ["WEB CHOWDECK TECHNOLOGIES LAGOS"] },
  { date: "19-Sep-2026", ref: "POS260919172903", debit: "45,250.50", balance: "2,166,139.00", remarks: ["POS SHOPRITE LEKKI"] },
  { date: "24-Sep-2026", ref: "090110260924150117002", credit: "1,983,611.00", balance: "4,149,750.00", remarks: ["NIP/ACME TECHNOLOGIES LTD/", "SALARY SEPTEMBER 2026"] },
];
export const PAGE2: Row[] = [
  { date: "25-Sep-2026", ref: "000013260925101452001", debit: "250,000.00", balance: "3,899,750.00", remarks: ["TRF/RENT SEPT/FRM ADA OKAFOR", "TO OLUWASEUN ADEYEMI"] },
];

