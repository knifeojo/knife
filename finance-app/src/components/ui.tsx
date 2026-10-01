import { formatMoney } from "@/lib/money";

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-tight text-lg">
      <span className="grid place-items-center size-7 rounded-lg bg-accent text-accent-ink text-sm" aria-hidden>
        L
      </span>
      Ledger
    </span>
  );
}

export function Money({
  minor,
  currency = "NGN",
  signed,
  type,
  compact,
  className = "",
}: {
  minor: bigint;
  currency?: string;
  signed?: boolean;
  type?: string;
  compact?: boolean;
  className?: string;
}) {
  const credit = type === "CREDIT";
  const text = formatMoney(minor, currency, { compact });
  return (
    <span className={`num ${signed && credit ? "text-credit" : ""} ${className}`}>
      {signed ? (credit ? "+" : "−") : ""}
      {text}
    </span>
  );
}

export function Stat({ label, minor, hint, emphasis }: { label: string; minor: bigint; hint?: string; emphasis?: boolean }) {
  return (
    <div className="card p-5">
      <div className="label">{label}</div>
      <div className={`mt-2 num font-semibold tracking-tight ${emphasis ? "text-3xl" : "text-2xl"}`}>{formatMoney(minor, "NGN", { compact: true })}</div>
      {hint && <div className="mt-1 text-xs text-ink-3">{hint}</div>}
    </div>
  );
}

export function Card({ title, action, children, className = "" }: { title?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card p-5 ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between mb-4 gap-2">
          {title && <h2 className="font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-ink-2 mt-1">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-ink-3 py-8 text-center">{children}</div>;
}

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "accent" | "warn" }) {
  const cls =
    tone === "accent" ? "bg-accent-soft text-accent" : tone === "warn" ? "bg-warn-bg text-warn-ink" : "bg-surface-2 text-ink-2";
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>;
}

export function lagosDateLabel(d: Date, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }) {
  return d.toLocaleDateString("en-GB", { ...opts, timeZone: "Africa/Lagos" });
}

export function relativeTime(d: Date | null | undefined, now = new Date()) {
  if (!d) return "never";
  const s = Math.round((now.getTime() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
