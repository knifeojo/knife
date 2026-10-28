import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { googleConfigured } from "@/core/providers/gmail";
import { Badge, Card, Empty, Money, PageHeader, lagosDateLabel, relativeTime } from "@/components/ui";
import { SyncButton } from "@/components/sync-button";
import { StatementUpload } from "@/components/statement-upload";
import { openIssues } from "@/core/statement-import";
import { disconnectGmail, importMboxAction, importPastAlerts, importSampleAlerts, saveImapConnection, syncNow } from "../actions";
import { defaultSyncMinutes } from "@/core/alerts/secrets";

const NOTICES: Record<string, { tone: "accent" | "warn"; text: string }> = {
  denied: { tone: "warn", text: "Gmail access was not granted. Nothing was connected." },
  demo: { tone: "warn", text: "Demo accounts cannot connect Gmail. Create a real account first." },
  unconfigured: { tone: "warn", text: "Gmail is not configured on this server yet." },
  error: { tone: "warn", text: "Something went wrong connecting Gmail. Please try again." },
};

const EXTRA_NOTICES: Record<string, { tone: "accent" | "warn"; text: string }> = {
  saved: { tone: "accent", text: "IMAP settings saved. Put the app password in IMAP_PASSWORD or ~/.ledger/secrets.env. It is never stored here." },
  demo: { tone: "warn", text: "Demo accounts cannot connect IMAP." },
  error: { tone: "warn", text: "Check the IMAP host, port and username." },
};

export default async function Accounts({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const [accounts, connections, runs] = await Promise.all([
    db.account.findMany({ where: { userId: user.id }, include: { _count: { select: { transactions: true } } }, orderBy: { createdAt: "asc" } }),
    db.financialConnection.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
    db.syncRun.findMany({ where: { userId: user.id }, orderBy: { startedAt: "desc" }, take: 5 }),
  ]);
  const issues = await openIssues(user.id);
  const gmail = connections.find((c) => c.provider === "gmail" && c.status !== "revoked");
  const imap = connections.find((c) => c.provider === "imap" && c.status !== "revoked");
  const notice =
    sp.gmail === "connected"
      ? { tone: "accent" as const, text: `Gmail connected. Scanned ${sp.scanned ?? 0} alerts and found ${sp.found ?? 0} new transactions${Number(sp.failed) ? `; ${sp.failed} could not be parsed` : ""}.` }
      : sp.gmail ? NOTICES[sp.gmail]
      : sp.imap ? EXTRA_NOTICES[sp.imap]
      : sp.mbox === "ok" ? { tone: "accent" as const, text: `Read ${sp.scanned ?? 0} mbox messages: ${sp.found ?? 0} posted, ${sp.review ?? 0} sent to Review.` }
      : undefined;

  return (
    <>
      <PageHeader title="Accounts" subtitle="Your bank accounts and the sources that feed them." />
      {notice && <div className={`mb-4 rounded-xl px-4 py-3 text-sm ${notice.tone === "accent" ? "bg-accent-soft text-accent" : "bg-warn-bg text-warn-ink"}`}>{notice.text}</div>}

      {issues.length > 0 && (
        <Link href="/app/accounts/issues" className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-warn-bg text-warn-ink px-4 py-3 text-sm">
          <span><strong>{issues.length} row{issues.length > 1 ? "s" : ""} from your statements</strong> could not be read. Nothing is lost; add them in a few taps.</span>
          <span className="font-medium underline">Review</span>
        </Link>
      )}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Bank accounts">
          {accounts.length ? (
            <ul className="divide-y divide-border">
              {accounts.map((a) => (
                <li key={a.id} className="py-3 flex justify-between gap-3">
                  <div>
                    <div className="font-medium">{a.accountName}</div>
                    <div className="text-xs text-ink-3">{a.institution} · {a.maskedAccountNumber} · {a._count.transactions} transactions</div>
                  </div>
                  <div className="text-right">
                    {a.balanceMinor !== null ? <Money minor={a.balanceMinor} currency={a.currency} className="font-semibold" /> : <span className="text-ink-3 text-sm">No balance yet</span>}
                    {a.balanceUpdatedAt && <div className="text-xs text-ink-3">as of {lagosDateLabel(a.balanceUpdatedAt)}</div>}
                  </div>
                </li>
              ))}
            </ul>
          ) : <Empty>No accounts yet. Connect Gmail to discover them from your alerts.</Empty>}
          <p className="mt-3 text-xs text-ink-3">Balances are the latest balance reported in an alert or statement, not a live bank balance.</p>
        </Card>

        <Card title="Gmail bank alerts" action={gmail && <Badge tone={gmail.status === "active" ? "accent" : "warn"}>{gmail.status === "active" ? "Connected" : "Needs attention"}</Badge>}>
          {gmail ? (
            <div className="space-y-4">
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-ink-3 text-xs">Mailbox</dt><dd className="truncate">{gmail.providerAccountId}</dd></div>
                <div><dt className="text-ink-3 text-xs">Last synced</dt><dd>{relativeTime(gmail.lastSyncedAt)}</dd></div>
                <div><dt className="text-ink-3 text-xs">Access</dt><dd>Read-only</dd></div>
                <div><dt className="text-ink-3 text-xs">Background</dt><dd>Every {gmail.syncIntervalMinutes ?? defaultSyncMinutes()} min</dd></div>
              </dl>
              {gmail.lastError && <p className="text-sm text-warn-ink bg-warn-bg rounded-lg px-3 py-2">{gmail.lastError}</p>}
              <div className="flex flex-wrap gap-3 items-start">
                <SyncButton action={syncNow} provider="gmail" />
                <SyncButton action={importPastAlerts} provider="gmail" label="Import past alerts" />
                <form action={disconnectGmail}><button className="btn btn-danger">Disconnect Gmail</button></form>
              </div>
              <p className="text-xs text-ink-3">Disconnecting revokes our access at Google and deletes the stored tokens. Your ledger stays until you delete it in Settings.</p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-ink-2">Connect Gmail with read-only access. We scan for GTBank transaction alerts and turn them into your ledger.</p>
              <Link href="/app/accounts/connect" className="btn btn-primary">Connect Gmail</Link>
              {!googleConfigured() && <p className="text-xs text-ink-3">Google OAuth is not configured on this server yet.</p>}
            </div>
          )}
        </Card>
      </div>

      <Card title="Yahoo Mail and other IMAP" className="mt-4">
        <p className="text-sm text-ink-2 mb-3">
          Read-only IMAP with an app password. Host, port and username are stored here. The password stays in <code>IMAP_PASSWORD</code> or <code>~/.ledger/secrets.env</code> on this Mac. It is never in the database, never in the repo, never returned by the API.
        </p>
        {imap && (
          <p className="text-sm mb-3">Last synced {relativeTime(imap.lastSyncedAt)}{imap.lastError ? ` · ${imap.lastError}` : ""}</p>
        )}
        <form action={saveImapConnection} className="grid sm:grid-cols-3 gap-3 items-end">
          <div>
            <label className="label" htmlFor="imapHost">Host</label>
            <input id="imapHost" name="imapHost" className="input mt-1" defaultValue={imap?.imapHost ?? "imap.mail.yahoo.com"} required />
          </div>
          <div>
            <label className="label" htmlFor="imapPort">Port</label>
            <input id="imapPort" name="imapPort" className="input mt-1" defaultValue={imap?.imapPort ?? 993} />
          </div>
          <div>
            <label className="label" htmlFor="imapUser">Username</label>
            <input id="imapUser" name="imapUser" className="input mt-1" defaultValue={imap?.imapUser ?? ""} required />
          </div>
          <button className="btn btn-secondary">{imap ? "Save IMAP" : "Connect IMAP"}</button>
        </form>
        {imap && <div className="mt-3"><SyncButton action={syncNow} provider="imap" /></div>}
      </Card>

      <Card title="Import past alerts from an .mbox file" className="mt-4">
        <p className="text-sm text-ink-2 mb-3">One-time upload. Messages are parsed in memory and discarded. Only known bank senders are posted.</p>
        <form action={importMboxAction} className="flex flex-wrap gap-3 items-center">
          <input type="file" name="mbox" accept=".mbox,.txt" className="text-sm" />
          <button className="btn btn-secondary">Upload mbox</button>
        </form>
      </Card>

      {!user.isDemo && (
        <Card title="Import bank statements" className="mt-4">
          <p className="text-sm text-ink-2 mb-4">
            No Gmail needed. Download statements from your bank app or internet banking as PDF, CSV or Excel and upload them here, several at once if you like. We detect the bank and account from each file, and transactions you already have (from alerts or earlier statements) are merged, not duplicated. Files are read once and not stored.{" "}
            Samples to try: <a href="/sample-gtbank-statement.pdf" download className="text-accent underline">PDF</a>, <a href="/sample-gtbank-statement.csv" download className="text-accent underline">CSV</a>.
          </p>
          <StatementUpload />
        </Card>
      )}

      {!user.isDemo && (
        <Card title="Try the pipeline with sample alerts" className="mt-4">
          <p className="text-sm text-ink-2 mb-4">
            Runs 13 synthetic GTBank alert emails (debits, credits, HTML, plaintext, a resent duplicate, a malformed alert and non-bank email) through the real parser, dedup and categorization pipeline. Run it twice to see deduplication.
          </p>
          <SyncButton action={importSampleAlerts} label="Import sample alerts" />
        </Card>
      )}

      <Card title="Sync history" className="mt-4">
        {runs.length ? (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full text-sm min-w-[560px]">
              <thead><tr className="text-left text-xs text-ink-3 border-b border-border"><th className="font-normal px-5 py-2">When</th><th className="font-normal">Status</th><th className="font-normal text-right">Scanned</th><th className="font-normal text-right">New</th><th className="font-normal text-right">Duplicates</th><th className="font-normal text-right px-5">Parse failures</th></tr></thead>
              <tbody className="num">
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-2">{relativeTime(r.startedAt)}</td>
                    <td><Badge tone={r.status === "success" ? "accent" : "warn"}>{r.status}</Badge></td>
                    <td className="text-right">{r.emailsScanned}</td>
                    <td className="text-right">{r.created}</td>
                    <td className="text-right">{r.duplicates}</td>
                    <td className="text-right px-5">{r.parseFailures}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No syncs yet.</Empty>}
      </Card>
    </>
  );
}
