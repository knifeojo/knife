import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth";
import { startDemo } from "./(auth)/actions";

const STEPS = [
  { t: "Connect", d: "Grant read-only access to your Gmail. We look only for bank transaction alerts." },
  { t: "Ingest", d: "Each GTBank alert becomes a structured transaction. Duplicates are merged automatically." },
  { t: "Understand", d: "Transactions are categorised, merchants cleaned up, income and recurring payments detected." },
  { t: "Ask", d: "Ask questions in plain English. Every number comes straight from your ledger." },
];

const PROMISES = [
  "We never ask for your bank login, PIN, OTP or card details",
  "Read-only Gmail access: we cannot send, delete or change email",
  "Email bodies are parsed in memory and discarded, never stored",
  "We cannot move money. There is no transfer feature, by design",
];

export default async function Landing() {
  if (await getCurrentUser()) redirect("/app");
  return (
    <main className="min-h-screen">
      <header className="mx-auto max-w-6xl flex items-center justify-between px-4 sm:px-6 h-16">
        <Logo />
        <nav className="flex items-center gap-2">
          <Link href="/login" className="btn btn-ghost">Log in</Link>
          <Link href="/signup" className="btn btn-primary">Get started</Link>
        </nav>
      </header>

      <section className="mx-auto max-w-6xl px-4 sm:px-6 pt-12 sm:pt-20 pb-16 grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <p className="label text-accent">For GTBank customers, more banks soon</p>
          <h1 className="mt-4 text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.08]">
            Your financial data, finally understandable.
          </h1>
          <p className="mt-5 text-lg text-ink-2 max-w-xl">
            Turn the bank alerts already sitting in your inbox into a clean ledger you can ask anything. No bank passwords. Ever.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/signup" className="btn btn-primary h-12 px-6 text-base">Connect your bank alerts</Link>
            <form action={startDemo}>
              <button className="btn btn-secondary h-12 px-6 text-base">Try the demo</button>
            </form>
          </div>
          <p className="mt-3 text-xs text-ink-3">The demo uses sample data. No sign up needed.</p>
        </div>

        <div className="card p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="label">September</span>
            <span className="text-xs text-ink-3">GTBank ••4521</span>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-4">
            {[["Income", "₦4.82M"], ["Expenses", "₦2.17M"], ["Net", "₦2.65M"]].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-ink-3">{k}</dt>
                <dd className="num text-xl font-semibold mt-1">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-6 rounded-xl bg-surface-2 p-4">
            <p className="text-sm font-medium">&ldquo;How much did I spend on food this month?&rdquo;</p>
            <p className="text-sm text-ink-2 mt-2">You spent ₦238,400.00 on Food in September 2026 (9 transactions).</p>
          </div>
          <p className="mt-3 text-[11px] text-ink-3">Illustration</p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-16">
        <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {STEPS.map((s, i) => (
            <li key={s.t} className="card p-5">
              <span className="num text-xs text-ink-3">0{i + 1}</span>
              <h3 className="mt-2 font-semibold">{s.t}</h3>
              <p className="mt-1 text-sm text-ink-2">{s.d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6 pb-24">
        <div className="card p-6 sm:p-8">
          <h2 className="text-xl font-semibold">Built to be trusted with your money data</h2>
          <ul className="mt-4 grid sm:grid-cols-2 gap-3">
            {PROMISES.map((p) => (
              <li key={p} className="flex gap-3 text-sm text-ink-2">
                <span className="text-accent font-bold" aria-hidden>✓</span>
                {p}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
