import Link from "next/link";
import { Logo } from "@/components/ui";
import { Nav } from "@/components/nav";
import { requireUser } from "@/lib/auth";
import { logout } from "../(auth)/actions";
import { buildQuestions } from "@/core/review";
import { ImportStatus } from "@/components/import-status";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const reviewCount = user.isDemo ? 0 : (await buildQuestions(user.id)).length;
  return (
    <div className="min-h-screen">
      {user.isDemo && (
        <div className="bg-warn-bg text-warn-ink text-sm">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2">
            <span>
              <strong className="font-semibold tracking-wide">DEMO DATA</strong>
              <span className="mx-2" aria-hidden>·</span>
              Sample transactions for a fictional GTBank customer. Nothing here is real.
            </span>
            <Link href="/signup" className="underline font-medium">Create a real account</Link>
          </div>
        </div>
      )}
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:grid lg:grid-cols-[200px_1fr] lg:gap-8">
        <aside className="hidden lg:flex flex-col gap-6 py-6 sticky top-0 h-screen">
          <Link href="/app"><Logo /></Link>
          <Nav variant="side" reviewCount={reviewCount} />
          <div className="mt-auto pb-2 space-y-2">
            <p className="text-xs text-ink-3 truncate" title={user.email}>{user.isDemo ? "Demo user" : user.email}</p>
            <form action={logout}><button className="btn btn-ghost px-2 h-8 text-sm">Log out</button></form>
          </div>
        </aside>
        <div className="min-w-0">
          <header className="lg:hidden py-4 space-y-3">
            <div className="flex items-center justify-between">
              <Link href="/app"><Logo /></Link>
              <form action={logout}><button className="btn btn-ghost h-8 px-2 text-sm">Log out</button></form>
            </div>
            <Nav variant="top" reviewCount={reviewCount} />
          </header>
          <main className="py-6 pb-16">
            <ImportStatus userId={user.id} />
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
