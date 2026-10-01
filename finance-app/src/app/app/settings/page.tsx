import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import { logout } from "../../(auth)/actions";
import { askAgainAction, deleteMyData, measureAccuracyAction, reapplyCategoriesAction, runAiCategorizeAction, setAiConsentAction } from "../actions";
import { aiConfigured } from "@/core/ai/client";
import { scoreHistory } from "@/core/eval";
import { SKIPPED } from "@/core/review";
import { SyncButton } from "@/components/sync-button";

export default async function Settings() {
  const user = await requireUser();
  const [txCount, learned, me, history] = await Promise.all([
    db.transaction.count({ where: { userId: user.id } }),
    db.merchantAlias.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 20 }),
    db.user.findUniqueOrThrow({ where: { id: user.id }, select: { aiConsent: true } }),
    scoreHistory(user.id, 8),
  ]);
  const configured = aiConfigured();
  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title="Settings" />
      <Card title="Profile">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-xs text-ink-3">Name</dt><dd>{user.name ?? "Not set"}</dd></div>
          <div><dt className="text-xs text-ink-3">Email</dt><dd className="truncate">{user.isDemo ? "Demo account" : user.email}</dd></div>
        </dl>
      </Card>
      <Card title="AI assistant">
        <p className="text-sm text-ink-2">
          When on, Ledger uses Claude (by Anthropic) to categorize transactions the rules can&rsquo;t place and to answer free-form questions.
          It sends transaction descriptions (with account numbers and long references removed), payee names and your labels. It never sends
          logins, and every figure it shows comes from your own ledger.
        </p>
        {!configured && <p className="mt-3 text-sm rounded-lg bg-warn-bg text-warn-ink px-3 py-2">Not available yet: this server has no Anthropic API key.</p>}
        <div className="mt-4 flex flex-wrap items-start gap-3">
          <form action={setAiConsentAction}>
            <input type="hidden" name="on" value={me.aiConsent ? "0" : "1"} />
            <button className={`btn ${me.aiConsent ? "btn-secondary" : "btn-primary"}`} disabled={user.isDemo}>{me.aiConsent ? "Turn AI off" : "Turn AI on"}</button>
          </form>
          {me.aiConsent && configured && <SyncButton action={runAiCategorizeAction} label="Run AI categorization now" />}
        </div>
      </Card>
      <Card title="Accuracy">
        <p className="text-sm text-ink-2 mb-3">How often Ledger would have categorized your answered transactions correctly on its own, before you told it.</p>
        {history.length ? (
          <table className="w-full text-sm num mb-3">
            <thead><tr className="text-left text-xs text-ink-3"><th className="font-normal">When</th><th className="font-normal">Method</th><th className="font-normal text-right">By count</th><th className="font-normal text-right">By value</th><th className="font-normal text-right">Spend placed</th></tr></thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-t border-border">
                  <td className="py-1">{h.createdAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                  <td>{h.method === "rules" ? "Rules" : "Rules + AI"}</td>
                  <td className="text-right">{h.labelled ? Math.round((h.correct / h.labelled) * 100) : 0}% <span className="text-ink-3">({h.correct}/{h.labelled})</span></td>
                  <td className="text-right">{h.labelledMinor > 0n ? Math.round(Number((h.correctMinor * 1000n) / h.labelledMinor) / 10) : 0}%</td>
                  <td className="text-right">{Math.round(h.coverage * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-sm text-ink-3 mb-3">No measurements yet.</p>}
        <SyncButton action={measureAccuracyAction} label="Measure accuracy now" />
      </Card>
      <Card title="Categorization">
        <p className="text-sm text-ink-2 mb-3">Re-apply the latest rules to all transactions you have not changed by hand.</p>
        <SyncButton action={reapplyCategoriesAction} label="Re-run categorization" />
      </Card>
      <Card title="Learned categories">
        {learned.length ? (
          <ul className="text-sm divide-y divide-border">
            {learned.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 py-2">
                <span className="truncate">{l.canonicalName}</span>
                {l.subcategory === SKIPPED ? (
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-ink-3">Can&rsquo;t remember</span>
                    <form action={askAgainAction}>
                      <input type="hidden" name="pattern" value={l.pattern} />
                      <button className="btn btn-secondary h-7 px-2 text-xs">Ask again</button>
                    </form>
                  </span>
                ) : (
                  <span className="text-ink-2 shrink-0">{l.category ?? "Not me"}{l.subcategory ? ` / ${l.subcategory}` : ""}</span>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-ink-3">When you change a transaction&rsquo;s category, future transactions from the same merchant or person follow it. Those rules appear here.</p>}
      </Card>
      <Card title="Privacy and data">
        <ul className="text-sm text-ink-2 space-y-1.5 list-disc pl-5">
          <li>We never store your bank password, PIN, OTP or card details. We never ask for them.</li>
          <li>Gmail access is read-only. Tokens are encrypted and never sent to your browser.</li>
          <li>Email bodies are parsed in memory and discarded. We keep the transaction fields plus sender and subject.</li>
        </ul>
        <form action={deleteMyData} className="mt-4">
          <button className="btn btn-danger">Delete my {txCount.toLocaleString()} transactions and synced data</button>
        </form>
      </Card>
      <form action={logout}><button className="btn btn-secondary">Log out</button></form>
    </div>
  );
}
