import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";

/** One visual line per row. A form-feed starts a new page, matching a statement that breaks mid-row. */
export async function makeTextPdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const pageText of text.split("\f")) {
    const page = doc.addPage([595, 842]);
    let y = 810;
    for (const line of pageText.split("\n")) {
      if (y < 36) break;
      if (line.trim()) page.drawText(line, { x: 36, y, size: 9, font });
      y -= 16;
    }
  }
  return Buffer.from(await doc.save());
}

// Synthetic Pesa wallet PDF. The date and the CAD->GBP narration wrap across lines.
// Running balances follow the amounts so the statement self-check can pass.
export async function makePesaPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page1 = doc.addPage([595, 842]);
  const page2 = doc.addPage([595, 842]);
  const paint = (page: PDFPage, rows: { y: number; parts: [string, number, boolean?][] }[]) => {
    for (const row of rows) {
      for (const [text, x, strong] of row.parts) {
        const face: PDFFont = strong ? bold : font;
        page.drawText(text, { x, y: row.y, size: 9, font: face });
      }
    }
  };
  paint(page1, [
    { y: 800, parts: [["Account Statement", 40, true]] },
    { y: 780, parts: [["JANE ADA", 40]] },
    { y: 766, parts: [["DOE", 40]] },
    { y: 748, parts: [["Email: jane@example.com", 40]] },
    { y: 734, parts: [["Date Issued: Oct 20, 2026", 40]] },
    { y: 720, parts: [["Period: Oct 20, 2025 - Oct 20, 2026", 40]] },
    { y: 706, parts: [["Wallet: CAOO123456789", 40]] },
    { y: 692, parts: [["Balance: $1.23", 40]] },
    { y: 660, parts: [["Date", 40, true], ["Transaction Details", 120, true], ["Amount", 400, true], ["Balance", 480, true]] },
    { y: 648, parts: [["($)", 400], ["($)", 480]] },
    { y: 620, parts: [["Oct 25,", 40]] },
    { y: 602, parts: [["2025", 40], ["ACME INC / Payroll for Oct 2025", 120], ["4,000.00", 400], ["4,120.50", 480]] },
    { y: 570, parts: [["Oct 26,", 40]] },
    { y: 552, parts: [["2025", 40], ["Money transfer to DOE JANE ADA", 120], ["(500.00)", 400], ["3,620.50", 480]] },
    { y: 520, parts: [["Oct 28,", 40]] },
    { y: 502, parts: [["2025", 40]] },
    { y: 484, parts: [["Money transfer to 5.00 CAD debited from CAD wallet to fund GBP wallet (2.70", 40]] },
    { y: 466, parts: [["GBP) (3.60)", 40], ["3,616.90", 480]] },
  ]);
  paint(page2, [
    { y: 800, parts: [["Date", 40, true], ["Transaction Details", 120, true], ["Amount", 400, true], ["Balance", 480, true]] },
    { y: 788, parts: [["($)", 400], ["($)", 480]] },
    { y: 750, parts: [["Nov 3, 2025", 40], ["Payout of $50.00 was successfully reversed", 120], ["50.00", 400], ["3,666.90", 480]] },
  ]);
  return Buffer.from(await doc.save());
}
