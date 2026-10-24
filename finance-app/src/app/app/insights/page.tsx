import { requireUser } from "@/lib/auth";
import { SUGGESTED_QUESTIONS } from "@/core/ask/answer";
import { cloudAiAllowed } from "@/core/ai/client";
import { PageHeader } from "@/components/ui";
import { AskBox } from "./ask-box";

const AI_SUGGESTIONS = [
  "How did September go?",
  "Where did most of my money go last month?",
  "How much have I sent my family this year?",
  "Who paid me the most, and how regular is it?",
  "Compare this month with last month",
  "What are my regular monthly commitments?",
];

export default async function Insights() {
  const user = await requireUser();
  const aiOn = await cloudAiAllowed(user.id);
  return (
    <div className="max-w-3xl">
      <PageHeader title="Insights" subtitle="Ask about your money in plain English. Every figure comes from your ledger." />
      <AskBox suggestions={aiOn ? AI_SUGGESTIONS : SUGGESTED_QUESTIONS} aiOn={aiOn} />
    </div>
  );
}
