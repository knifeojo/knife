"use client";

import { useActionState, useRef, useState, startTransition } from "react";
import { importStatementsAction, type StatementState } from "@/app/app/actions";

const BANKS = ["GTBank", "Access Bank", "Zenith Bank", "UBA", "First Bank", "Kuda", "OPay", "Moniepoint", "Other"];

export function StatementUpload({ compact = false }: { compact?: boolean }) {
  const [state, action, pending] = useActionState<StatementState, FormData>(importStatementsAction, undefined);
  // Files are kept in state (not only in the file input, which the browser clears after a submit)
  // so a failed file can be retried, e.g. with the right password, without choosing it again.
  const [files, setFiles] = useState<File[]>([]);
  const formRef = useRef<HTMLFormElement>(null);

  const submit = (only?: File[]) => {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    fd.delete("files");
    for (const f of only ?? files) fd.append("files", f);
    startTransition(() => action(fd));
  };

  const results = !pending && state && "results" in state ? state.results : [];
  const failedFiles = files.filter((f) => results.some((r) => r.file === f.name && "error" in r));
  const ok = results.filter((r) => "ok" in r);
  const created = ok.reduce((s, r) => s + ("ok" in r ? r.ok.created + (r.ok.others ?? []).reduce((t, o) => t + o.created, 0) : 0), 0);
  const incomplete = ok.filter((r) => "ok" in r && [r.ok, ...(r.ok.others ?? [])].some((x) => !x.complete));
  const names = files.map((f) => f.name);
  const hasPdf = names.some((n) => n.toLowerCase().endsWith(".pdf"));

  return (
    <form ref={formRef} onSubmit={(e) => (e.preventDefault(), submit())} className="space-y-4">
      <label className="block rounded-xl border-2 border-dashed border-border bg-surface-2 p-5 text-center cursor-pointer hover:border-accent">
        <input
          type="file"
          multiple
          accept=".pdf,.csv,.xlsx,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <span className="font-medium">{files.length ? `${files.length} file${files.length > 1 ? "s" : ""} selected` : "Choose statement files"}</span>
        <span className="block text-xs text-ink-3 mt-1">
          {files.length ? names.join(", ") : "PDF, CSV or Excel (.xlsx). Up to 10 files, 5 MB each. Different banks and overlapping dates are fine."}
        </span>
      </label>
      {hasPdf && (
        <div>
          <label htmlFor="pdfPassword" className="label">PDF password, if your statement has one</label>
          <input id="pdfPassword" name="pdfPassword" type="password" autoComplete="off" className="input mt-1 max-w-xs" />
          <p className="text-xs text-ink-3 mt-1">The statement file&rsquo;s password (banks usually email it with the statement). Used once to open the file, never stored. This is not your bank login.</p>
        </div>
      )}
      {!compact && (
        <div>
          <label htmlFor="institution" className="label">Bank if not detected</label>
          <select id="institution" name="institution" defaultValue="" className="input mt-1 w-48">
            <option value="">Auto-detect</option>
            {BANKS.map((b) => <option key={b}>{b}</option>)}
          </select>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={pending || !files.length}>
          {pending
            ? `Importing ${files.length > 1 ? `${files.length} files` : "your statement"}…`
            : files.length > 1 ? `Import ${files.length} statements` : "Import statement"}
        </button>
        {failedFiles.length > 0 && (
          <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => submit(failedFiles)}>
            Retry {failedFiles.length > 1 ? `${failedFiles.length} failed files` : "failed file"}
          </button>
        )}
      </div>
      {pending && (
        <p className="text-sm text-ink-2" role="status">
          Reading {hasPdf ? "PDFs can take a few seconds" : "your file"}. Please keep this page open.
        </p>
      )}

      {!pending && state && "error" in state && (
        <p className="rounded-lg bg-warn-bg text-danger px-3 py-2 text-sm" role="alert">✕ {state.error}</p>
      )}
      {results.length > 0 && (
        <div role="status" className={`rounded-lg px-3 py-2 text-sm ${failedFiles.length || incomplete.length ? "bg-warn-bg text-warn-ink" : "bg-accent-soft text-accent"}`}>
          <p className="font-medium">
            {ok.length === 0
              ? "✕ Nothing was imported. Your ledger is unchanged."
              : failedFiles.length
                ? `! ${ok.length} of ${results.length} files imported (${created} new transactions). ${failedFiles.length} could not be read.`
                : incomplete.length
                  ? `! Imported (${created} new transactions), but some rows need your attention. Nothing is lost.`
                  : created === 0
                    ? `✓ Imported successfully. Everything in ${ok.length > 1 ? "these files" : "this statement"} was already in your ledger, so nothing was duplicated.`
                    : `✓ Successfully imported ${ok.length > 1 ? `${ok.length} files` : "your statement"}: ${created} new transaction${created === 1 ? "" : "s"} added.`}
          </p>
          {results.filter((r) => "error" in r).map((r) => (
            <p key={r.file} className="mt-1">✕ <span className="font-medium">{r.file}</span>: {"error" in r ? r.error : ""}</p>
          ))}
          {(failedFiles.length > 0 || incomplete.length > 0) && (
            <p className="mt-1 text-xs">
              {failedFiles.length > 0 && "Failed files were not imported at all and nothing from them is in your ledger. Fix the issue above and press Retry. "}
              {incomplete.length > 0 && "Rows that couldn't be read are listed at the top of the page with a link to add them."}
            </p>
          )}
        </div>
      )}
    </form>
  );
}
