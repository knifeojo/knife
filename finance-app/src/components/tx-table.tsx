import type { Account, Transaction } from "@prisma/client";
import { Badge, Money, lagosDateLabel } from "./ui";
import { CategorySelect } from "./category-select";

const SOURCE_LABEL: Record<string, string> = { gmail: "Gmail", fixture: "Sample", demo: "Demo", statement: "Statement", mono: "Open banking", sms: "SMS" };

export function TxTable({ rows, editable = true, showBalance = true }: { rows: (Transaction & { account?: Account })[]; editable?: boolean; showBalance?: boolean }) {
  return (
    <div className="overflow-x-auto -mx-5">
      <table className="w-full text-sm min-w-[720px]">
        <thead>
          <tr className="text-left text-xs text-ink-3 border-b border-border">
            <th className="font-normal px-5 py-2">Date</th>
            <th className="font-normal py-2">Description</th>
            <th className="font-normal py-2">Category</th>
            <th className="font-normal py-2 text-right">Amount</th>
            {showBalance && <th className="font-normal py-2 text-right">Balance</th>}
            <th className="font-normal px-5 py-2 text-right">Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className="border-b border-border last:border-0 align-top">
              <td className="px-5 py-3 whitespace-nowrap text-ink-2 num">{lagosDateLabel(t.transactionDate, { day: "numeric", month: "short" })}</td>
              <td className="py-3 pr-4 max-w-[320px]">
                <div className="font-medium truncate">{t.merchantName ?? t.counterparty ?? t.description}</div>
                <div className="text-xs text-ink-3 truncate" title={t.description}>{t.description}</div>
              </td>
              <td className="py-3 pr-4">
                {editable ? <CategorySelect id={t.id} value={t.category} /> : <Badge>{t.category}</Badge>}
                {t.transferPairId && <div className="mt-1"><Badge tone="accent">Between your accounts</Badge></div>}
                {t.classificationSource === "ai" && <div className="mt-1"><Badge>AI suggestion</Badge></div>}
                {t.classificationSource === "default" && t.classificationConfidence < 0.5 && (
                  <div className="mt-1"><Badge tone="warn">Needs review</Badge></div>
                )}
              </td>
              <td className="py-3 text-right whitespace-nowrap font-medium">
                <Money minor={t.amountMinor} currency={t.currency} signed type={t.type} />
              </td>
              {showBalance && (
                <td className="py-3 text-right whitespace-nowrap text-ink-3">
                  {t.balanceAfterMinor !== null ? <Money minor={t.balanceAfterMinor} currency={t.currency} compact /> : null}
                </td>
              )}
              <td className="px-5 py-3 text-right text-xs text-ink-3 whitespace-nowrap">{SOURCE_LABEL[t.source] ?? t.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
