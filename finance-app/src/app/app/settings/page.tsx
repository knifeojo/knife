import Link from "next/link";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Card, PageHeader } from "@/components/ui";
import { logout } from "../../(auth)/actions";
import { askAgainAction, clearManualRateAction, deleteMyData, dismissForwardingNotice, importMarketRatesAction, measureAccuracyAction, reapplyCategoriesAction, runAiCategorizeAction, setAiConsentAction, setAiRoutesAction, setFxPreferenceAction, setManualRateAction } from "../actions";
import { ensureUserTokens, inboundAddress } from "@/core/alerts/tokens";
import { defaultSyncMinutes } from "@/core/alerts/secrets";
import { relativeTime } from "@/components/ui";
import { FX_CURRENCIES, listFxForSettings } from "@/core/fx/provider";
import { formatMoney } from "@/lib/money";
import { AI_FEATURES, type AiRoute } from "@/core/ai/client";
import { aiSettingsStatus } from "@/core/ai/status";
import { scoreHistory } from "@/core/eval";
import { SKIPPED } from "@/core/review";
import { SyncButton } from "@/components/sync-button";

const ROUTE_LABEL: Record<AiRoute, string> = { local: "Local", cloud: "Cloud (redacted)", off: "Off" };

export default async function Settings() {
  const user = await requireUser();
  const tokens = await ensureUserTokens(user.id);
  const inbound = inboundAddress(tokens.inboundEmailToken);
  const [txCount, learned, history, status, connections, notices, fx] = await Promise.all([
    db.transaction.count({ where: { userId: user.id } }),
    db.merchantAlias.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 20 }),
    scoreHistory(user.id, 8),
    aiSettingsStatus(user.id),
    db.financialConnection.findMany({ where: { userId: user.id, status: { not: "revoked" } } }),
    db.forwardingNotice.findMany({ where: { userId: user.id, status: "new" }, orderBy: { receivedAt: "desc" }, take: 5 }),
    listFxForSettings(user.id),
  ]);
  const lastSync = connections.reduce<Date | null>((acc, c) => (!c.lastSyncedAt ? acc : !acc || c.lastSyncedAt > acc ? c.lastSyncedAt : acc), null);
  const ready = status.reachable && status.modelInstalled;
  const localReady = status.local.reachable && status.local.modelInstalled;
  const cloud = status.cloudProvider;
  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title="Settings" />
      <Card title="Profile">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div><dt className="text-xs text-ink-3">Name</dt><dd>{user.name ?? "Not set"}</dd></div>
          <div><dt className="text-xs text-ink-3">Email</dt><dd className="truncate">{user.isDemo ? "Demo account" : user.email}</dd></div>
        </dl>
      </Card>
      <Card title="Bank alerts">
        <p className="text-sm text-ink-2">Last synced {relativeTime(lastSync)}. Background sync runs every {defaultSyncMinutes()} minutes while this server is up.</p>
        <p className="text-sm text-ink-2 mt-2">
          Manage Gmail, IMAP and &ldquo;Sync now&rdquo; on <Link href="/app/accounts" className="text-accent underline">Accounts</Link>.
        </p>
        <div className="mt-4 space-y-3 text-sm">
          <div>
            <div className="text-xs text-ink-3">Personal forwarding address</div>
            <p className="font-mono break-all">{inbound ?? `alerts-${tokens.inboundEmailToken}@your-domain (set INBOUND_EMAIL_DOMAIN to activate)`}</p>
            <p className="text-xs text-ink-3 mt-1">Gmail → Settings → Forwarding → add this address. Confirm the code that appears below, then import the filter XML so only bank senders are forwarded.</p>
            {inbound && (
              <a className="btn btn-secondary h-9 text-sm mt-2 inline-flex" href="/app/alerts/filters">Download Gmail filters</a>
            )}
          </div>
          <div>
            <div className="text-xs text-ink-3">iPhone Shortcuts token</div>
            <p className="font-mono break-all">{tokens.smsIngestToken}</p>
            <p className="text-xs text-ink-3 mt-1">Header <code>X-Ledger-Sms-Token</code> on <code>POST /api/v1/alerts/sms</code>. See docs/alert-ingestion.md.</p>
          </div>
        </div>
        {notices.length > 0 && (
          <div className="mt-4 rounded-lg bg-accent-soft p-3 text-sm">
            <p className="font-medium">Gmail forwarding confirmation</p>
            {notices.map((n) => (
              <div key={n.id} className="mt-2">
                {n.code && <p>Code: <span className="font-mono">{n.code}</span></p>}
                {n.link && <p><a className="text-accent underline break-all" href={n.link}>Open confirmation link</a></p>}
                <form action={dismissForwardingNotice} className="mt-1">
                  <input type="hidden" name="id" value={n.id} />
                  <button className="btn btn-ghost h-8 px-2 text-xs">Dismiss</button>
                </form>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card title="Exchange rates">
        <p className="text-sm text-ink-2">
          Official (interbank) and street naira rates differ. Ledger uses a <strong>realised</strong> rate
          from your own wallet-to-bank conversions when one is within 7 days of the transaction:
          a quoted payout rate on the wallet line, a Deel withdrawal matched to the same- or next-day
          naira credit, or a linked pair (same-day withdrawals are averaged by amount). A pair more
          than 20% off the typical rate is ignored and flagged in Review. Market is only a fallback.
          A seed from months earlier is labelled approximate.
        </p>
        <form action={setFxPreferenceAction} className="mt-3 flex flex-wrap items-end gap-2">
          <div>
            <label className="label" htmlFor="fx-preference">Naira rate to prefer</label>
            <select id="fx-preference" name="preference" defaultValue={fx.preference} className="input mt-1" disabled={user.isDemo}>
              <option value="official">Official / market feed</option>
              <option value="street">Street (my manual override)</option>
            </select>
          </div>
          <button className="btn btn-secondary" disabled={user.isDemo}>Save preference</button>
        </form>
        <p className="mt-3 text-xs text-ink-3">
          Market source: {fx.sourceLabel}. {fx.latestMarketDate ? `Latest cached day: ${fx.latestMarketDate}.` : "No daily rates cached yet — refresh below or enter a street rate."}
        </p>
        <div className="mt-3">
          <SyncButton action={importMarketRatesAction} label="Refresh daily market rates" />
        </div>
        <form action={setManualRateAction} className="mt-4 grid grid-cols-2 gap-2 items-end">
          <div>
            <label className="label" htmlFor="fx-base">Street override</label>
            <select id="fx-base" name="base" className="input mt-1" disabled={user.isDemo}>
              {FX_CURRENCIES.map((c) => <option key={c} value={c}>{c} → NGN</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="fx-rate">Naira per 1 unit</label>
            <input id="fx-rate" name="rate" inputMode="decimal" placeholder="1550" className="input mt-1" disabled={user.isDemo} />
          </div>
          <div className="col-span-2">
            <button className="btn btn-secondary" disabled={user.isDemo}>Save street rate</button>
          </div>
        </form>
        {fx.manual.length > 0 && (
          <ul className="mt-3 text-sm divide-y divide-border">
            {fx.manual.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                <span className="num">{r.base}/{r.quote} · {r.rate.toFixed(2)} · {r.date}</span>
                <form action={clearManualRateAction}>
                  <input type="hidden" name="base" value={r.base} />
                  <button className="btn btn-secondary h-7 px-2 text-xs" disabled={user.isDemo}>Clear</button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {fx.realised.length > 0 && (
          <div className="mt-4">
            <p className="text-xs text-ink-3">From your own conversions (realised)</p>
            <ul className="mt-1 text-sm divide-y divide-border">
              {fx.realised.map((r) => (
                <li key={r.id} className="flex justify-between gap-3 py-1.5 num">
                  <span>{r.base} → NGN</span>
                  <span>{formatMoney(BigInt(Math.round(r.rate * 100)))} per 1 {r.base} · {r.date}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      <Card title="Your people">
        <p className="text-sm text-ink-2">
          Family, friends and people you pay. Their relationship decides how payments with them are labelled (spouse, siblings, parents, black tax, your own other account), ahead of the AI.
        </p>
        <Link href="/app/people" className="btn btn-secondary h-9 text-sm mt-3" data-testid="settings-people">Manage your people</Link>
      </Card>
      <Card title="AI">
        <p className="text-sm text-ink-2">
          {status.mode === "hybrid"
            ? "Hybrid: categorization runs on a model on this machine (Ollama). Insights, chat and second opinions on unsure categories use a cloud model (Anthropic), and everything sent there is redacted first: no account, card or phone numbers, emails or real names, and amounts are rounded or shown as ranges."
            : status.mode === "ollama"
              ? "Local only: every AI feature runs on this machine through Ollama. Nothing leaves your computer."
              : status.mode === "anthropic"
                ? "Cloud: AI features use Anthropic. Everything sent is redacted first: no account, card or phone numbers, emails or real names, and amounts are rounded or shown as ranges."
                : "AI is off on this server."}{" "}
          Categories are only suggestions: they wait in Review until you confirm them, and Afford stays rule-based.
        </p>
        <div className="mt-3 grid sm:grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border border-border p-3" data-testid="ai-local">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">Local · Ollama</span>
              <span className={localReady ? "text-accent" : "text-warn-ink"}>{localReady ? "Reachable" : status.local.reachable ? "Model missing" : "Not reachable"}</span>
            </div>
            <p className="font-mono text-xs mt-1 truncate">{status.local.model}</p>
            <p className="text-xs text-ink-3 mt-1">{status.local.message}</p>
          </div>
          <div className="rounded-lg border border-border p-3" data-testid="ai-cloud">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">Cloud · Anthropic</span>
              <span className={cloud.reachable ? "text-accent" : "text-warn-ink"}>{cloud.reachable ? "Reachable" : cloud.keySet ? "Not reachable" : "No key"}</span>
            </div>
            <p className="font-mono text-xs mt-1 truncate">{cloud.model}</p>
            <p className="text-xs text-ink-3 mt-1">ANTHROPIC_API_KEY: {cloud.keySet ? "set" : "not set"}. {cloud.message}</p>
          </div>
        </div>
        {status.notes.map((n) => (
          <p key={n} className="mt-3 text-sm rounded-lg px-3 py-2 bg-warn-bg text-warn-ink">{n}</p>
        ))}
        <form action={setAiRoutesAction} className="mt-4">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-ink-3"><th className="font-normal">Feature</th><th className="font-normal">Your choice</th><th className="font-normal">Runs on</th></tr></thead>
            <tbody>
              {AI_FEATURES.map((f) => {
                const r = status.routes[f];
                return (
                  <tr key={f} className="border-t border-border align-top">
                    <td className="py-2 pr-2">{r.label}</td>
                    <td className="py-2 pr-2">
                      <select name={f} aria-label={`${r.label} runs on`} defaultValue={r.source === "user" ? r.requested : "default"} className="input h-8 py-0 text-xs" disabled={user.isDemo}>
                        <option value="default">Server default ({ROUTE_LABEL[r.serverDefault]})</option>
                        <option value="local">Local</option>
                        <option value="cloud">Cloud</option>
                        <option value="off">Off</option>
                      </select>
                    </td>
                    <td className="py-2" data-testid={`ai-route-${f}`}>
                      <span className={r.route === "cloud" ? "text-ink" : r.route === "local" ? "text-accent" : "text-ink-3"}>{ROUTE_LABEL[r.route]}</span>
                      {r.note && <span className="block text-xs text-ink-3">{r.note}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button className="btn btn-secondary mt-2" disabled={user.isDemo}>Save AI choices</button>
        </form>
        {status.enabled && (
          <p className="mt-3 text-xs text-ink-3 num">
            {status.backlog} uncertain transactions not yet looked at · {status.pendingSuggestions} suggestions waiting in Review
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-start gap-3">
          <form action={setAiConsentAction}>
            <input type="hidden" name="on" value={status.enabled ? "0" : "1"} />
            <button className={`btn ${status.enabled ? "btn-secondary" : "btn-primary"}`} disabled={user.isDemo || (!status.enabled && !status.available)}>{status.enabled ? "Turn AI off" : "Turn AI on"}</button>
          </form>
          {status.enabled && (ready || status.routes.escalation.route === "cloud") && status.routes.categorize.route !== "off" && <SyncButton action={runAiCategorizeAction} label="Suggest categories now" />}
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
          <button className="btn btn-danger">Delete my {txCount.toLocaleString()} transactions, loans and synced data</button>
        </form>
      </Card>
      <form action={logout}><button className="btn btn-secondary">Log out</button></form>
    </div>
  );
}
