import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { ALL_CATEGORIES } from "@/core/categorize";
import { listPeople, type PersonSummary } from "@/core/people";
import { RELATIONSHIPS } from "@/core/people-match";
import { formatMoney } from "@/lib/money";
import { Badge, Card, PageHeader } from "@/components/ui";
import {
  addPeopleTextAction, addPersonAction, deletePersonAction, mergePeopleAction, undoPeopleAction, updatePersonAction,
} from "../actions";

const monthName = (m: string) => new Date(`${m}-01T12:00:00Z`).toLocaleString("en-NG", { month: "short", timeZone: "UTC" });
const VENDOR_CATEGORIES = ALL_CATEGORIES.filter((c) => c !== "Income" && c !== "Own transfer");

function RelationshipSelect({ name = "relationship", value, id }: { name?: string; value?: string; id: string }) {
  return (
    <select id={id} name={name} defaultValue={value ?? "spouse"} className="input mt-1">
      {RELATIONSHIPS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
    </select>
  );
}

function PersonCard({ p, others }: { p: PersonSummary; others: PersonSummary[] }) {
  const months = p.months.filter((m) => m.inMinor || m.outMinor);
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">{p.displayName}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge tone="accent">{p.relationshipLabel}</Badge>
            {p.category && <span className="text-xs text-ink-3">Payments go to {p.subcategory ? `${p.category} / ${p.subcategory}` : p.category}</span>}
            {p.note && <span className="text-xs text-ink-3">&ldquo;{p.note}&rdquo;</span>}
          </div>
        </div>
        <div className="text-right shrink-0 num">
          {p.outMinor > 0n && <div className="font-semibold" title={p.outDetail ?? undefined}>−{formatMoney(p.outMinor)}</div>}
          {p.inMinor > 0n && <div className="text-credit" title={p.inDetail ?? undefined}>+{formatMoney(p.inMinor)}</div>}
          {(p.outDetail || p.inDetail) && <div className="text-xs text-ink-3">{[p.outDetail && `sent ${p.outDetail}`, p.inDetail && `received ${p.inDetail}`].filter(Boolean).join(" · ")}</div>}
          <div className="text-xs text-ink-3">{p.count} payment{p.count === 1 ? "" : "s"}{p.lastDate ? ` · last ${p.lastDate}` : ""}</div>
        </div>
      </div>

      {months.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm num min-w-[320px]">
            <thead><tr className="text-left text-xs text-ink-3"><th className="font-normal py-1">Month</th><th className="font-normal text-right">You sent</th><th className="font-normal text-right">They sent</th></tr></thead>
            <tbody>
              {p.months.map((m) => (
                <tr key={m.month} className="border-t border-border">
                  <td className="py-1.5">{monthName(m.month)} {m.month.slice(0, 4)}</td>
                  <td className="text-right">{m.outMinor ? formatMoney(m.outMinor) : "—"}</td>
                  <td className="text-right">{m.inMinor ? formatMoney(m.inMinor) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4">
        <p className="text-xs text-ink-3">How your bank writes them</p>
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {p.aliases.map((a) => (
            <li key={a.name} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs ${a.rejected ? "bg-surface-2 text-ink-3 line-through" : "bg-accent-soft text-accent"}`}>
              <span className="font-mono">{a.name}</span>
              {!a.rejected && (
                <form action={updatePersonAction}>
                  <input type="hidden" name="id" value={p.id} />
                  <input type="hidden" name="alias" value={a.name} />
                  <input type="hidden" name="aliasOp" value="reject" />
                  <button className="hover:underline" title={`${a.name} is someone else`}>not them</button>
                </form>
              )}
              <form action={updatePersonAction}>
                <input type="hidden" name="id" value={p.id} />
                <input type="hidden" name="alias" value={a.name} />
                <input type="hidden" name="aliasOp" value="remove" />
                <button aria-label={`Remove ${a.name}`} className="hover:underline">×</button>
              </form>
            </li>
          ))}
        </ul>
        <form action={updatePersonAction} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="id" value={p.id} />
          <input type="hidden" name="aliasOp" value="add" />
          <input name="alias" required maxLength={80} placeholder="Another spelling, e.g. OJO GIFT A" className="input h-9 w-64" aria-label="Another spelling" />
          <button className="btn btn-secondary h-9 text-sm">Add spelling</button>
        </form>
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-sm text-accent font-medium list-none">Change, merge or remove…</summary>
        <form action={updatePersonAction} className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="id" value={p.id} />
          <div>
            <label className="label" htmlFor={`r-${p.id}`}>Who they are</label>
            <RelationshipSelect id={`r-${p.id}`} value={p.relationship} />
          </div>
          <div>
            <label className="label" htmlFor={`v-${p.id}`}>If a vendor: paid for</label>
            <select id={`v-${p.id}`} name="vendorCategory" defaultValue={p.vendorCategory ?? ""} className="input mt-1 w-40">
              <option value="">Vendors (default)</option>
              {VENDOR_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={`vs-${p.id}`}>Label</label>
            <input id={`vs-${p.id}`} name="vendorSubcategory" defaultValue={p.vendorSubcategory ?? ""} maxLength={40} className="input mt-1 w-36" />
          </div>
          <div>
            <label className="label" htmlFor={`n-${p.id}`}>Note</label>
            <input id={`n-${p.id}`} name="note" defaultValue={p.note ?? ""} maxLength={120} className="input mt-1 w-40" />
          </div>
          <button className="btn btn-primary h-10">Save and relabel</button>
        </form>
        {others.length > 0 && (
          <form action={mergePeopleAction} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="sourceId" value={p.id} />
            <div>
              <label className="label" htmlFor={`m-${p.id}`}>Same person as</label>
              <select id={`m-${p.id}`} name="targetId" className="input mt-1 w-56">
                {others.map((o) => <option key={o.id} value={o.id}>{o.displayName} ({o.relationshipLabel})</option>)}
              </select>
            </div>
            <button className="btn btn-secondary h-10">Merge into them</button>
          </form>
        )}
        <form action={deletePersonAction} className="mt-3">
          <input type="hidden" name="id" value={p.id} />
          <button className="btn btn-ghost h-9 px-2 text-sm text-warn-ink">Remove {p.displayName}</button>
        </form>
      </details>
    </Card>
  );
}

export default async function People({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const { people, undo } = await listPeople(user.id);
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Your people"
        subtitle="Who you send money to and get money from. Ledger labels every payment with them from who they are: family support, black tax, your own other account."
      />

      {sp.added !== undefined && (
        <Card className="mb-4">
          <p className="text-sm">
            Added {sp.added} {sp.added === "1" ? "person" : "people"} and relabelled {sp.updated ?? 0} payment{sp.updated === "1" ? "" : "s"}.
          </p>
          {sp.unread && (
            <p className="text-sm text-warn-ink mt-1">
              Could not read: {sp.unread.split("\n").map((l) => `“${l}”`).join(", ")}. Try &ldquo;My sister is Ada Obi&rdquo;.
            </p>
          )}
        </Card>
      )}

      {undo && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 px-4 py-2.5" data-testid="people-undo">
          <p className="text-sm">Last change: {undo.label} ({undo.changed} payment{undo.changed === 1 ? "" : "s"} relabelled)</p>
          <form action={undoPeopleAction}>
            <input type="hidden" name="batchId" value={undo.batchId} />
            <button className="btn btn-secondary h-9 text-sm">Undo</button>
          </form>
        </div>
      )}

      <Card title="Tell Ledger who they are" className="mb-6">
        <form action={addPeopleTextAction}>
          <label className="label" htmlFor="people-text">One per line, in your own words</label>
          <textarea
            id="people-text"
            name="text"
            rows={3}
            maxLength={2000}
            className="input mt-1 h-auto py-2"
            placeholder={"My wife is Gift Adebayo Ojo\nMy brother is Tunde Ojo\nNgozi Okafor is my aunty"}
          />
          <button className="btn btn-primary h-10 mt-2">Add and relabel</button>
        </form>
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-accent font-medium list-none">Or add one person…</summary>
          <form action={addPersonAction} className="mt-3 flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-48">
              <label className="label" htmlFor="p-name">Name (as your bank writes it)</label>
              <input id="p-name" name="displayName" required maxLength={80} placeholder="e.g. Gift Adebayo Ojo" className="input mt-1" />
            </div>
            <div>
              <label className="label" htmlFor="p-rel">Who they are</label>
              <RelationshipSelect id="p-rel" />
            </div>
            <div>
              <label className="label" htmlFor="p-note">Note</label>
              <input id="p-note" name="note" maxLength={120} placeholder="e.g. wife" className="input mt-1 w-32" />
            </div>
            <button className="btn btn-primary h-10">Add</button>
          </form>
        </details>
        <p className="text-xs text-ink-3 mt-3">
          Spellings match even when banks cut names short, reorder them or use initials (&ldquo;OJO GIFT A&rdquo;). Close calls are asked in{" "}
          <Link href="/app/review" className="text-accent underline">Review</Link>, never guessed. Every change can be undone. These names stay on your device and are never sent to the cloud.
        </p>
      </Card>

      {people.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-2">No one yet. Add your family above, or answer the &ldquo;Who is … to you?&rdquo; questions in <Link href="/app/review" className="text-accent underline">Review</Link>.</p>
        </Card>
      ) : (
        <ul className="space-y-4">
          {people.map((p) => (
            <li key={p.id}><PersonCard p={p} others={people.filter((o) => o.id !== p.id)} /></li>
          ))}
        </ul>
      )}
    </div>
  );
}
