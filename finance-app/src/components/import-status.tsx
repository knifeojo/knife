import Link from "next/link";
import { openIssues, recentImportResults } from "@/core/statement-import";
import { buildQuestions } from "@/core/review";
import { formatMoney } from "@/lib/money";
import { dismissImportResultsAction } from "@/app/app/actions";

// Shown at the top of every page after an import until dismissed, so the result survives the page
// changing underneath (e.g. the welcome screen turning into the dashboard after the first import).
export async function ImportStatus({ userId }: { userId: string }) {
  const runs = await recentImportResults(userId);
  if (!runs.length) return null;
  const [issues, questions] = await Promise.all([openIssues(userId), buildQuestions(userId)]);
  const failed = runs.filter((r) => r.status === "failed");
  const partial = runs.filter((r) => r.status === "partial");
  const needsPassword = runs.filter((r) => r.status === "needs_password");
  const unrecognised = runs.filter((r) => r.status === "unrecognised");
  const created = runs.reduce((s, r) => s + r.created, 0);
  const merged = runs.reduce((s, r) => s + r.duplicates, 0);
  const linked = runs.reduce((s, r) => s + r.linked, 0);
  const attention = failed.length + partial.length + needsPassword.length + unrecognised.length;
  const tone = failed.length === runs.length ? "fail" : attention ? "partial" : "ok";
  const styles = {
    ok: { box: "bg-accent-soft border-accent/30", icon: "✓", title: "Import complete" },
    partial: {
      box: "bg-warn-bg border-warn-ink/20",
      icon: "!",
      title: needsPassword.length && !failed.length && !partial.length && !unrecognised.length
        ? "A statement needs a password"
        : unrecognised.length && !failed.length && !partial.length && !needsPassword.length
          ? "A statement layout was not recognised"
          : failed.length
            ? "Import finished, but some files could not be read"
            : "Imported, but some rows need your attention",
    },
    fail: { box: "bg-warn-bg border-danger/30", icon: "✕", title: "Import failed" },
  }[tone];

  return (
    <div role="status" className={`mb-5 rounded-xl border px-4 py-3 ${styles.box}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex gap-3 min-w-0">
          <span className={`grid place-items-center size-6 shrink-0 rounded-full text-sm font-bold ${tone === "ok" ? "bg-accent text-accent-ink" : tone === "fail" ? "bg-danger text-white" : "bg-warn-ink text-warn-bg"}`} aria-hidden>
            {styles.icon}
          </span>
          <div className="min-w-0">
            <p className="font-semibold">{styles.title}</p>
            {tone !== "fail" && (
              <p className="text-sm text-ink-2">
                {created} new transaction{created === 1 ? "" : "s"} added{merged ? `, ${merged} already in your ledger (not duplicated)` : ""}.
                {linked > 0 && ` Linked ${linked} transfer${linked > 1 ? "s" : ""} between your own accounts, so that money is counted once.`}
              </p>
            )}
            <ul className="mt-2 space-y-1 text-sm">
              {runs.map((r) => (
                <li key={r.id} className="flex flex-wrap gap-x-2">
                  <span aria-hidden>{r.status === "failed" || r.status === "unrecognised" ? "✕" : r.status === "needs_password" ? "!" : "✓"}</span>
                  <span className="font-medium truncate max-w-[60vw]">{r.label ?? "Statement"}</span>
                  <span className={r.status === "failed" || r.status === "unrecognised" ? "text-danger" : "text-ink-2"}>
                    {r.status === "needs_password"
                      ? "Needs a password. Enter it in Review. It stays on this machine."
                      : r.status === "unrecognised"
                        ? `Unrecognised layout. ${r.error ?? ""}`
                        : r.status === "duplicate"
                          ? "Already imported, so it was not added again."
                          : r.status === "failed"
                            ? `${r.error ?? "Could not be imported"} ${fixHint(r.error ?? "")}`
                            : `${r.emailsScanned} rows read · ${r.created} new · ${r.duplicates} already there${r.parseFailures ? ` · ${r.parseFailures} rows could not be read` : ""}`}
                  </span>
                  {r.gapMinor ? (
                    <span className="basis-full text-warn-ink pl-5">
                      The statement&rsquo;s running balance doesn&rsquo;t match the imported rows in {r.balanceBreaks} place{r.balanceBreaks > 1 ? "s" : ""}: {formatMoney(r.gapMinor)} is unaccounted for.
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {tone !== "fail" && questions.length > 0 && (
              <Link href="/app/review" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2 text-sm border border-border hover:bg-surface-2">
                <span>
                  <strong>Ledger has {questions.length} question{questions.length > 1 ? "s" : ""} about your data.</strong>{" "}
                  {questions.some((q) => q.kind === "conversion") ? "Some money may be counted twice; " : ""}
                  your answers make the numbers right.
                </span>
                <span className="font-medium text-accent">Answer now</span>
              </Link>
            )}
            <div className="mt-2 flex flex-wrap gap-4 text-sm font-medium">
              {needsPassword.length > 0 && (
                <Link href="/app/review" className="text-warn-ink underline">Enter {needsPassword.length} statement password{needsPassword.length > 1 ? "s" : ""}</Link>
              )}
              {issues.length > 0 && (
                <Link href="/app/accounts/issues" className="text-warn-ink underline">Fix {issues.length} unreadable row{issues.length > 1 ? "s" : ""}</Link>
              )}
              {tone !== "fail" && <Link href="/app/transactions" className="text-accent underline">View transactions</Link>}
            </div>
          </div>
        </div>
        <form action={dismissImportResultsAction}>
          <button className="btn btn-ghost h-8 px-2 text-sm" aria-label="Dismiss import result">Dismiss</button>
        </form>
      </div>
    </div>
  );
}

/** What to do about a whole-file failure, in plain words. */
function fixHint(error: string): string {
  if (/password-protected/i.test(error)) return "Enter the statement password (usually in the email from your bank) and import again.";
  if (/wrong password/i.test(error)) return "Check the password and try again.";
  if (/scanned|no readable text/i.test(error)) return "Download the e-statement from your bank app or internet banking (not a scan or photo).";
  if (/xls/i.test(error)) return "Open it in Excel or Google Sheets, save as .xlsx or .csv, and import that.";
  if (/header row/i.test(error)) return "The layout wasn't recognised. Try the CSV or Excel version of the same statement.";
  if (/5 MB|too large|more than/i.test(error)) return "Split it into shorter date ranges.";
  return "Your files were not stored. Fix the issue and import again.";
}
