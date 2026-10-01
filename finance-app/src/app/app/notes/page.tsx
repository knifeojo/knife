import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { NotesForm } from "./notes-form";

export default async function NotesPage() {
  await requireUser();
  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader
        title="Add your notes"
        subtitle="Paste rough notes on where your money went. Ledger matches them to your bank transactions to learn what payments were for. Your notes never change an amount, a date or a label you already gave."
      />
      <NotesForm />
    </div>
  );
}
