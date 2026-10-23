"use client";

import Link from "next/link";
import { startTransition, useActionState } from "react";
import { formatMoney } from "@/lib/money";
import { lagosDateLabel } from "@/components/ui";
import type { AffordabilityJson } from "@/core/affordability";
import { affordAction, type AffordState } from "../actions";

const money = (minor: string) => formatMoney(BigInt(minor));
const day = (iso: string, offsetMs = 0) => lagosDateLabel(new Date(Date.parse(iso) + offsetMs), { day: "numeric", month: "short" });

const VERDICT = {
  yes: { label: "Yes", cls: "bg-brand text-brand-ink" },
  stretch: { label: "Stretch", cls: "bg-warn-bg text-warn-ink" },
  no: { label: "No", cls: "bg-danger text-white" },
} as const;

const BUFFER_RULE = { obligations: "one month of fixed obligations", floor: "Ledger's minimum", yours: "your choice" } as const;
const INCOME_RULE = { paydays: "regular paydays Ledger found", monthly: "one typical month per full 30 days", none: "none counted" } as const;

export function AffordForm() {
  const [state, action, pending] = useActionState<AffordState, FormData>(affordAction, undefined);
  return (
    <div className="space-y-4">
      <form
        className="card p-5 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          startTransition(() => action(fd));
        }}
      >
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="label">Price</span>
            <input name="amount" required inputMode="decimal" autoComplete="off" placeholder="2,500,000 or 2.5m" className="input mt-1.5 text-base num" aria-describedby="amount-hint" />
            <span id="amount-hint" className="mt-1 block text-xs text-ink-3">Naira. You can type 500k or 2.5m.</span>
          </label>
          <label className="block">
            <span className="label">What is it? (optional)</span>
            <input name="description" maxLength={80} autoComplete="off" placeholder="A used car" className="input mt-1.5" />
          </label>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="label">Look ahead</span>
            <select name="horizon" defaultValue="month_end" className="input mt-1.5">
              <option value="month_end">To the end of this month</option>
              <option value="30">Next 30 days</option>
              <option value="90">Next 90 days</option>
            </select>
          </label>
          <label className="block">
            <span className="label">Safety buffer (optional)</span>
            <input name="buffer" inputMode="decimal" autoComplete="off" placeholder="One month of fixed bills" className="input mt-1.5 num" />
            <span className="mt-1 block text-xs text-ink-3">Money you never want to touch. At least ₦50,000.</span>
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn bg-brand text-brand-ink hover:opacity-90" disabled={pending}>{pending ? "Checking…" : "Check"}</button>
          <span className="text-xs text-ink-3">Nothing in your ledger changes.</span>
        </div>
        {state && "error" in state && <p className="text-sm text-danger" role="alert">{state.error}</p>}
      </form>

      {state && "result" in state && !pending && <Answer r={state.result} />}
    </div>
  );
}

function Answer({ r }: { r: AffordabilityJson }) {
  const v = VERDICT[r.verdict];
  const i = r.inputs, p = r.projection;
  return (
    <section className="space-y-4" aria-live="polite">
      <div className="card p-5">
        <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ${v.cls}`}>{v.label}</span>
        <p className="mt-3 text-[15px] leading-relaxed">{r.headline}</p>
        {r.detail.map((d) => <p key={d} className="mt-2 text-sm text-ink-2">{d}</p>)}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="card p-5">
          <h2 className="font-semibold">Your typical month</h2>
          <p className="text-xs text-ink-3 mt-0.5">{i.incomeMonths.length ? `From ${i.incomeMonths.join(", ")}` : "No months imported yet"}</p>
          <dl className="mt-3 text-sm">
            <Row label="Income" value={money(i.monthlyIncomeMinor)} />
            <Row label="Fixed obligations" value={`−${money(i.monthlyObligationsMinor)}`} />
            {i.obligations.map((o) => (
              <Row key={`${o.name}|${o.category}`} sub label={`${o.name} · ${o.label ?? o.category}`} value={money(o.monthlyMinor)} />
            ))}
            {i.otherLoanRepaymentsMinor !== "0" && <Row sub label="Other loan repayments" value={money(i.otherLoanRepaymentsMinor)} />}
            <Row label="Everyday spending" value={`−${money(i.monthlyEverydayMinor)}`} />
            <Row strong label="Usual surplus" value={money(i.monthlySurplusMinor)} />
          </dl>
        </div>

        <div className="card p-5">
          <h2 className="font-semibold">{day(r.window.from)} to {day(r.window.to, -1)}</h2>
          <p className="text-xs text-ink-3 mt-0.5">{r.window.startsAtBalanceDate ? "Starts on your balance date" : "Starts today"}</p>
          <dl className="mt-3 text-sm">
            <Row label={i.cashKnown ? `Cash${i.cashAsOf ? `, ${day(i.cashAsOf)}` : ""}` : "Cash on file (none)"} value={money(i.cashMinor)} />
            <Row label={`Income in (${INCOME_RULE[p.incomeRule]})`} value={`+${money(p.incomeInMinor)}`} />
            <Row label="Fixed obligations due" value={`−${money(p.obligationsOutMinor)}`} />
            <Row label="Everyday spending, estimated" value={`−${money(p.everydayOutMinor)}`} />
            <Row label={r.description ? `This purchase (${r.description})` : "This purchase"} value={`−${money(r.amountMinor)}`} />
            <Row strong label={`Lowest point, ${day(p.lowestOn)}`} value={money(p.lowestMinor)} />
            <Row label={`Safety buffer (${BUFFER_RULE[i.bufferRule]})`} value={money(i.bufferMinor)} />
            <Row strong label="Room above buffer" value={money(p.headroomMinor)} />
          </dl>
        </div>
      </div>

      {r.notes.length > 0 && (
        <ul className="card p-5 space-y-1.5 text-sm text-ink-2 list-disc pl-9">
          {r.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      <p className="text-xs text-ink-3">
        A figure looks wrong? Fix the category on <Link href="/app/transactions" className="text-brand underline">Transactions</Link>, then check again. Loan repayments must be in Debt to count as obligations.
      </p>
    </section>
  );
}

function Row({ label, value, strong, sub }: { label: string; value: string; strong?: boolean; sub?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 py-1.5 ${sub ? "pl-3 text-xs text-ink-3" : "border-b border-border"} ${strong ? "font-semibold" : ""}`}>
      <dt className="truncate">{label}</dt>
      <dd className="num shrink-0">{value}</dd>
    </div>
  );
}
