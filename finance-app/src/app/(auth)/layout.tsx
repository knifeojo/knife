import Link from "next/link";
import { Logo } from "@/components/ui";
import { startDemo } from "./actions";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <Link href="/" className="mb-8"><Logo /></Link>
      <div className="card w-full max-w-sm p-6 sm:p-8">{children}</div>
      <form action={startDemo} className="mt-6">
        <button className="btn btn-ghost text-sm">Or explore with demo data</button>
      </form>
    </main>
  );
}
