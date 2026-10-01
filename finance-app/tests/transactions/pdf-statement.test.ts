import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PDFDocument, degrees } from "pdf-lib";
import { PAGE1, PAGE2, makeStatementPdf } from "../fixtures/statement-pdf";
import { pdfToRows } from "@/core/pdf-statement";
import { parseStatementRows } from "@/core/statements";
import { importStatement } from "@/core/statement-import";
import { db } from "@/lib/db";

describe("PDF statement extraction", () => {
  it("rebuilds rows across pages, joins wrapped narrations, ignores footers", async () => {
    const rows = await pdfToRows(await makeStatementPdf([PAGE1, PAGE2]));
    const parsed = parseStatementRows(rows, { institution: "GTBank" });
    expect(parsed.errors).toEqual([]);
    expect(parsed.accountLast4).toBe("4521");
    expect(parsed.transactions).toHaveLength(4);
    const [chowdeck, shoprite, salary, rent] = parsed.transactions;
    expect(chowdeck).toMatchObject({ type: "DEBIT", amountMinor: 1_845_000n, balanceAfterMinor: 221_138_950n, reference: "WEB260916120301" });
    expect(shoprite.amountMinor).toBe(4_525_050n);
    expect(salary).toMatchObject({ type: "CREDIT", amountMinor: 198_361_100n, description: "NIP/ACME TECHNOLOGIES LTD/ SALARY SEPTEMBER 2026" });
    expect(rent.description).toBe("TRF/RENT SEPT/FRM ADA OKAFOR TO OLUWASEUN ADEYEMI");
    expect(rent.transactionDate.toISOString().slice(0, 10)).toBe("2026-09-25");
  });

  it("reads rotated landscape pages (stored rotated 90 degrees, as in some GTBank e-statements)", async () => {
    const pdf = await PDFDocument.load(await makeStatementPdf([PAGE1, PAGE2]));
    // Re-draw nothing: just mark pages as rotated and counter-rotate content, the way bank exports do.
    const rotated = await PDFDocument.create();
    for (const [i, src] of (await rotated.embedPdf(await pdf.save(), pdf.getPageIndices())).entries()) {
      const { width, height } = pdf.getPage(i).getSize();
      const page = rotated.addPage([height, width]);
      page.setRotation(degrees(90));
      page.drawPage(src, { x: height, y: 0, rotate: degrees(90) });
    }
    const rows = await pdfToRows(Buffer.from(await rotated.save()));
    const parsed = parseStatementRows(rows, { institution: "GTBank" });
    expect(parsed.errors).toEqual([]);
    expect(parsed.transactions.map((t) => t.amountMinor)).toEqual([1_845_000n, 4_525_050n, 198_361_100n, 25_000_000n]);
  });

  it("handles headers split over two lines", async () => {
    const rows = await pdfToRows(await makeStatementPdf([PAGE1], { twoLineHeader: true }));
    const parsed = parseStatementRows(rows, { institution: "GTBank" });
    expect(parsed.transactions).toHaveLength(3);
    expect(parsed.errors).toEqual([]);
  });

  it("imports end to end, detects the bank, and dedups a re-upload", async () => {
    const u = await db.user.create({ data: { email: "pdf@test.dev" } });
    const pdf = await makeStatementPdf([PAGE1, PAGE2]);
    const first = await importStatement(u.id, { name: "statement.pdf", bytes: pdf });
    expect(first).toMatchObject({ institution: "GTBank", currency: "NGN", accountLast4: "4521", created: 4, duplicates: 0 });
    const again = await importStatement(u.id, { name: "statement.pdf", bytes: pdf });
    expect(again).toMatchObject({ created: 0, duplicates: 4 });
    const rent = await db.transaction.findFirstOrThrow({ where: { userId: u.id, reference: "000013260925101452001" } });
    expect(rent.counterparty).toBe("Oluwaseun Adeyemi");
    expect(rent.category).toBe("Housing");
  });

  it("explains scanned PDFs with no text layer", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const empty = Buffer.from(await doc.save());
    const u = await db.user.create({ data: { email: "pdf-scan@test.dev" } });
    await expect(importStatement(u.id, { name: "scan.pdf", bytes: empty })).rejects.toThrow(/scanned/);
  });

  it("opens password-protected statements with the right password only", async () => {
    // tests/fixtures/encrypted-statement.pdf: the same 2-page statement encrypted with password "test1234"
    const enc = readFileSync("tests/fixtures/encrypted-statement.pdf");
    await expect(pdfToRows(enc)).rejects.toThrow(/password-protected/);
    await expect(pdfToRows(enc, "wrong")).rejects.toThrow(/Wrong password/);
    const parsed = parseStatementRows(await pdfToRows(enc, "test1234"), { institution: "GTBank" });
    expect(parsed.transactions).toHaveLength(4);
  });

  it("explains corrupt files", async () => {
    const u = await db.user.create({ data: { email: "pdf-bad@test.dev" } });
    await expect(importStatement(u.id, { name: "bad.pdf", bytes: Buffer.from("not a pdf") })).rejects.toThrow(/Could not open/);
  });
});
