"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV = [
  { href: "/app", label: "Overview" },
  { href: "/app/transactions", label: "Transactions" },
  { href: "/app/spending", label: "Spending" },
  { href: "/app/income", label: "Income" },
  { href: "/app/accounts", label: "Accounts" },
  { href: "/app/insights", label: "Insights" },
  { href: "/app/afford", label: "Can I afford it?" },
  { href: "/app/review", label: "Review" },
  { href: "/app/profile", label: "About you" },
  { href: "/app/notes", label: "Your notes" },
  { href: "/app/settings", label: "Settings" },
];

function Label({ label, href, reviewCount }: { label: string; href: string; reviewCount: number }) {
  return (
    <>
      {label}
      {href === "/app/review" && reviewCount > 0 && (
        <span className="ml-1.5 inline-grid place-items-center min-w-5 h-5 px-1 rounded-full bg-accent text-accent-ink text-[11px] font-semibold num">{reviewCount}</span>
      )}
    </>
  );
}

export function Nav({ variant, reviewCount = 0 }: { variant: "side" | "top"; reviewCount?: number }) {
  const path = usePathname();
  const active = (href: string) => (href === "/app" ? path === "/app" : path.startsWith(href));
  if (variant === "top") {
    return (
      <nav className="flex gap-1 overflow-x-auto -mx-4 px-4 pb-2" aria-label="Main">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={`shrink-0 rounded-full px-3 py-1.5 text-sm ${active(n.href) ? "bg-ink text-bg" : "text-ink-2 bg-surface border border-border"}`}
          >
            <Label label={n.label} href={n.href} reviewCount={reviewCount} />
          </Link>
        ))}
      </nav>
    );
  }
  return (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {NAV.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          aria-current={active(n.href) ? "page" : undefined}
          className={`rounded-lg px-3 py-2 text-sm ${active(n.href) ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:bg-surface-2"}`}
        >
          <Label label={n.label} href={n.href} reviewCount={reviewCount} />
        </Link>
      ))}
    </nav>
  );
}
