import { suggestInBackground } from "@/core/ai/categorizer";
import {
  MAX_STATEMENT_BYTES,
  MAX_STATEMENT_FILES,
  StatementFormatError,
  importStatement,
  recordFailedImport,
  type StatementImportSummary,
} from "@/core/statement-import";
import { log } from "@/lib/log";
import { apiError, apiJson, requireApiUser } from "@/lib/mobile/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FileResult = { file: string } & ({ ok: StatementImportSummary } | { error: string });

function safeFileName(name: string) {
  const base = name.split(/[/\\]/).pop()?.trim() || "statement";
  return base.replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "statement";
}

/** One or more PDF, CSV or Excel statements. Parsed in memory; the file and any PDF password are not stored. */
export async function POST(req: Request) {
  const auth = await requireApiUser(req);
  if ("response" in auth) return auth.response;

  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("multipart/form-data")) return apiError(415, "Upload the statement as multipart form data.");
  const len = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_STATEMENT_BYTES + 1024 * 1024) return apiError(413, "File is larger than 5 MB.");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError(400, "Could not read the upload.");
  }

  const files = [...form.getAll("file"), ...form.getAll("files")].filter((item): item is File => item instanceof File && item.size > 0);
  if (!files.length) return apiError(400, "Choose at least one statement file.");
  if (files.length > MAX_STATEMENT_FILES) return apiError(400, `Upload up to ${MAX_STATEMENT_FILES} files at a time.`);

  const institution = String(form.get("institution") ?? "").trim().slice(0, 80) || undefined;
  // Used once to open a password-protected PDF. Never logged or written to the database.
  const password = String(form.get("password") ?? form.get("pdfPassword") ?? "").slice(0, 200) || undefined;

  const results: FileResult[] = [];
  for (const file of files) {
    const name = safeFileName(file.name);
    try {
      if (file.size > MAX_STATEMENT_BYTES) throw new StatementFormatError("File is larger than 5 MB.");
      const summary = await importStatement(auth.user.id, { name, bytes: Buffer.from(await file.arrayBuffer()) }, { institution, password });
      results.push({ file: name, ok: summary });
    } catch (e) {
      const message = e instanceof StatementFormatError ? e.message : "Could not read this file.";
      if (!(e instanceof StatementFormatError)) log.error("statement.failed", { userId: auth.user.id, error: e instanceof Error ? e.message : "unknown" });
      results.push({ file: name, error: message });
      await recordFailedImport(auth.user.id, name, message);
    }
  }
  if (results.some((result) => "ok" in result)) suggestInBackground(auth.user.id);
  return apiJson({ results });
}
