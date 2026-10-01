import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { googleConfigured } from "@/core/providers/gmail";
import { Card, PageHeader } from "@/components/ui";

const BLOCKS = [
  {
    title: "What we access",
    body: "We read bank transaction alert emails so we can automatically build your financial history. We search only for alerts from your bank (GTBank today).",
  },
  {
    title: "What we don't do",
    body: "We cannot send emails, delete emails, change your mailbox, or access your bank credentials. We never ask for your bank password, PIN or OTP.",
  },
  {
    title: "Why we need it",
    body: "Your bank sends transaction alerts to your email. We turn those alerts into structured financial records.",
  },
  {
    title: "What we keep",
    body: "The date, amount, description and reference of each transaction, plus the sender and subject of the alert. Email bodies are read in memory and discarded. Access tokens are encrypted.",
  },
];

export default async function ConnectGmail() {
  const user = await requireUser();
  const configured = googleConfigured();
  return (
    <div className="max-w-2xl">
      <PageHeader title="Connect your bank alerts" subtitle="Read-only Gmail access. You can disconnect at any time." />
      <Card>
        <div className="space-y-5">
          {BLOCKS.map((b) => (
            <div key={b.title}>
              <h2 className="font-semibold">{b.title}</h2>
              <p className="text-sm text-ink-2 mt-1">{b.body}</p>
            </div>
          ))}
          <div className="rounded-xl bg-accent-soft p-4 text-sm">
            <strong>We only need read-only access to identify bank transaction alerts. We cannot send, delete, or modify your emails.</strong>
            <p className="mt-1 text-ink-2">Google will show a permission screen asking to &ldquo;View your email messages and settings&rdquo;. That is Google&rsquo;s wording for read-only access.</p>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap gap-3 items-center">
          {user.isDemo ? (
            <p className="text-sm text-warn-ink bg-warn-bg rounded-lg px-3 py-2">Demo accounts cannot connect Gmail. Create a real account first.</p>
          ) : configured ? (
            <form action="/api/gmail/connect" method="post">
              <button className="btn btn-primary">Continue with Google</button>
            </form>
          ) : (
            <p className="text-sm text-warn-ink bg-warn-bg rounded-lg px-3 py-2">
              Gmail connection is not configured on this server yet (missing Google OAuth credentials). Use sample alerts on the Accounts page to try the pipeline.
            </p>
          )}
          <Link href="/app/accounts" className="btn btn-ghost">Cancel</Link>
        </div>
      </Card>
    </div>
  );
}
