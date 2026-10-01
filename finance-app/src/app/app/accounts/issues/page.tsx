import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { guessFromRaw, openIssues } from "@/core/statement-import";
import { Card, PageHeader } from "@/components/ui";
import { IssueForm } from "./issue-form";

export default async function Issues() {
  const user = await requireUser();
  const issues = await openIssues(user.id);
  const byFile = new Map<string, typeof issues>();
  for (const i of issues) byFile.set(i.fileLabel, [...(byFile.get(i.fileLabel) ?? []), i]);
  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Rows that need your attention"
        subtitle={issues.length
          ? `${issues.length} row${issues.length > 1 ? "s" : ""} from your statements could not be read automatically. Nothing is lost: add each one to your ledger (we've prefilled what we could), or mark it as not a transaction.`
          : "Every row from your statements is accounted for."}
      />
      {!issues.length && (
        <Card><p className="text-sm text-ink-2">All clear. <Link href="/app/accounts" className="text-accent underline">Back to accounts</Link></p></Card>
      )}
      <div className="space-y-4">
        {[...byFile.entries()].map(([file, rows]) => (
          <Card key={file} title={file}>
            <ul className="divide-y divide-border">
              {rows.map((i) => (
                <li key={i.id} className="py-4 space-y-3">
                  <div>
                    <p className="text-xs text-ink-3">Row {i.rowNumber} · {i.reason}</p>
                    <p className="mt-1 font-mono text-xs bg-surface-2 rounded px-2 py-1.5 break-words">{i.rawText || "(empty row)"}</p>
                  </div>
                  <IssueForm issueId={i.id} guess={guessFromRaw(i.rawText)} />
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}
