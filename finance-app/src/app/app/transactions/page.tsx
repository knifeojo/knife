import Link from "next/link";
import { ALL_CATEGORIES } from "@/core/categorize";
import { listTransactions, type TransactionFilters } from "@/core/analytics";
import { cadenceIds, loadCadence, type Cadence } from "@/core/cadence";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { formatMoney, parseAmountToMinor } from "@/lib/money";
import { Card, Empty, PageHeader } from "@/components/ui";
import { TxTable } from "@/components/tx-table";

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

function lagosDayStart(s?: string) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  return new Date(`${s}T00:00:00+01:00`);
}

export default async function Transactions({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const page = Math.max(1, Number(one(sp.page)) || 1);
  const to = lagosDayStart(one(sp.to));
  const cadenceView: Cadence | undefined = one(sp.cadence) === "recurring" || one(sp.cadence) === "one_off" ? (one(sp.cadence) as Cadence) : undefined;
  const cadence = await loadCadence(user.id);
  const f: TransactionFilters = {
    q: one(sp.q)?.slice(0, 80),
    type: one(sp.type) === "DEBIT" || one(sp.type) === "CREDIT" ? (one(sp.type) as "DEBIT" | "CREDIT") : undefined,
    category: ALL_CATEGORIES.includes(one(sp.category) ?? "") ? one(sp.category) : undefined,
    accountId: one(sp.account),
    merchant: one(sp.merchant),
    from: lagosDayStart(one(sp.from)),
    to: to ? new Date(to.getTime() + 86400_000) : undefined,
    minMinor: one(sp.min) ? parseAmountToMinor(one(sp.min)!) ?? undefined : undefined,
    maxMinor: one(sp.max) ? parseAmountToMinor(one(sp.max)!) ?? undefined : undefined,
    ids: cadenceView ? await cadenceIds(user.id, cadence, cadenceView) : undefined,
  };
  const [data, accounts] = await Promise.all([
    listTransactions(user.id, f, page, 50),
    db.account.findMany({ where: { userId: user.id }, select: { id: true, accountName: true } }),
  ]);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const qs = (p: number) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (k !== "page" && one(v)) u.set(k, one(v)!);
    u.set("page", String(p));
    return `?${u}`;
  };

  return (
    <>
      <PageHeader title="Transactions" subtitle={`${data.total.toLocaleString()} transactions. Change a category and similar transactions learn from it.`} />
      <Card className="mb-4">
        <form className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-9 gap-3 items-end">
          <div className="col-span-2">
            <label className="label" htmlFor="q">Search</label>
            <input id="q" name="q" defaultValue={f.q} placeholder="Merchant, person, reference" className="input mt-1" />
          </div>
          <div>
            <label className="label" htmlFor="type">Type</label>
            <select id="type" name="type" defaultValue={f.type ?? ""} className="input mt-1">
              <option value="">All</option><option value="CREDIT">Credit</option><option value="DEBIT">Debit</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="category">Category</label>
            <select id="category" name="category" defaultValue={f.category ?? ""} className="input mt-1">
              <option value="">All</option>
              {ALL_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="cadence">Pattern</label>
            <select id="cadence" name="cadence" defaultValue={cadenceView ?? ""} className="input mt-1">
              <option value="">All</option><option value="recurring">Recurring</option><option value="one_off">One-off spends</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="account">Account</label>
            <select id="account" name="account" defaultValue={f.accountId ?? ""} className="input mt-1">
              <option value="">All</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountName}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="from">From</label>
            <input id="from" name="from" type="date" defaultValue={one(sp.from)} className="input mt-1" />
          </div>
          <div>
            <label className="label" htmlFor="to">To</label>
            <input id="to" name="to" type="date" defaultValue={one(sp.to)} className="input mt-1" />
          </div>
          <div>
            <label className="label" htmlFor="min">Min ₦</label>
            <input id="min" name="min" inputMode="decimal" defaultValue={one(sp.min)} className="input mt-1" />
          </div>
          <div className="col-span-2 md:col-span-4 lg:col-span-9 flex gap-2 justify-end">
            <Link href="/app/transactions" className="btn btn-ghost">Clear</Link>
            <button className="btn btn-primary">Apply filters</button>
          </div>
        </form>
      </Card>
      <Card>
        {cadenceView && (
          <p className="text-xs text-ink-3 mb-3">
            {cadenceView === "recurring"
              ? "Payments seen about once a month for 2 months or more, the same way Can I afford it? finds your bills. Recurring bills are the ones it counts as fixed."
              : `Single payments of at least ${formatMoney(cadence.oneOffMinMinor).replace(/\.00$/, "")} outside any regular stream, the same way Can I afford it? lists one-off spends. Loan repayments, fees and own transfers are never one-offs.`}
          </p>
        )}
        {data.rows.length ? <TxTable rows={data.rows} cadence={cadence} /> : <Empty>No transactions match these filters.</Empty>}
        {pages > 1 && (
          <div className="flex items-center justify-between mt-4 text-sm">
            <span className="text-ink-3">Page {page} of {pages}</span>
            <div className="flex gap-2">
              {page > 1 && <Link className="btn btn-secondary h-8" href={qs(page - 1)}>Previous</Link>}
              {page < pages && <Link className="btn btn-secondary h-8" href={qs(page + 1)}>Next</Link>}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
