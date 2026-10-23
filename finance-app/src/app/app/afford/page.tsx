import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, PageHeader } from "@/components/ui";
import { AffordForm } from "./afford-form";

export default async function Afford() {
  const user = await requireUser();
  const hasData = (await db.transaction.count({ where: { userId: user.id } })) > 0;
  return (
    <div className="max-w-3xl">
      <PageHeader title="Can I really afford this?" subtitle="Enter a price. Ledger checks it against your income, bills, a safety buffer and the days ahead, and says what would help." />
      {hasData ? (
        <AffordForm />
      ) : (
        <Card>
          <p className="text-sm text-ink-2">Ledger needs your transactions to answer this. Upload a recent bank statement first.</p>
          <Link href="/app/accounts" className="btn mt-4 bg-brand text-brand-ink hover:opacity-90">Upload a statement</Link>
        </Card>
      )}
    </div>
  );
}
