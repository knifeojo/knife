import type { Account, Transaction } from "@prisma/client";
import { cadenceOf, type CadenceIndex } from "@/core/cadence";
import type { SuggestionGroup } from "@/core/ai/suggestions";
import type { PeopleOverview, PersonSummary } from "@/core/people";

type TxWithAccount = Transaction & {
  account?: Pick<Account, "accountName" | "institution" | "maskedAccountNumber"> | null;
};

/** Money leaves the API as a decimal string of minor units so a JSON number cannot round it. */
export function minor(value: bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

export function accountJson(account: Account) {
  return {
    id: account.id,
    institution: account.institution,
    accountName: account.accountName,
    maskedAccountNumber: account.maskedAccountNumber,
    holderName: account.holderName,
    currency: account.currency,
    balanceMinor: minor(account.balanceMinor),
    balanceUpdatedAt: account.balanceUpdatedAt?.toISOString() ?? null,
  };
}

/** With a cadence index, adds `cadence` ("recurring" | "one_off" | null) and `recurringBill`. Older clients ignore both. */
type TxWithSources = TxWithAccount & { sources?: { source: string }[]; feeOfId?: string | null };

export function transactionJson(tx: TxWithSources, cadence?: CadenceIndex) {
  const kind = cadence ? cadenceOf(tx, cadence) : undefined;
  const sources = tx.sources?.length ? [...new Set(tx.sources.map((s) => s.source))] : [tx.source];
  return {
    id: tx.id,
    accountId: tx.accountId,
    accountName: tx.account?.accountName ?? null,
    institution: tx.account?.institution ?? null,
    maskedAccountNumber: tx.account?.maskedAccountNumber ?? null,
    transactionDate: tx.transactionDate.toISOString(),
    type: tx.type,
    amountMinor: tx.amountMinor.toString(),
    currency: tx.currency,
    description: tx.description,
    merchantName: tx.merchantName,
    counterparty: tx.counterparty,
    category: tx.category,
    subcategory: tx.subcategory,
    source: tx.source,
    sources,
    feeOfId: tx.feeOfId ?? null,
    ...(cadence && { cadence: kind ?? null, recurringBill: kind === "recurring" && !!cadence.recurring.get(tx.id)?.bill }),
  };
}

/** An AI suggestion as the phone sees it. Confirm or dismiss with POST /api/v1/review/suggestions { id, action }. */
export function suggestionJson(g: SuggestionGroup) {
  return {
    id: g.id,
    display: g.display,
    direction: g.type === "CREDIT" ? "in" : "out",
    category: g.category,
    subcategory: g.subcategory,
    reason: g.reason,
    confidence: g.confidence,
    model: g.model,
    count: g.count,
    totalMinor: minor(g.totalMinor),
    currentCategory: g.currentCategory,
    examples: g.examples,
    classificationSource: "ai",
  };
}

/** A person on "Your people", money as minor-unit strings. */
export function personJson(p: PersonSummary) {
  return {
    id: p.id,
    displayName: p.displayName,
    relationship: p.relationship,
    relationshipLabel: p.relationshipLabel,
    note: p.note,
    vendorCategory: p.vendorCategory,
    vendorSubcategory: p.vendorSubcategory,
    aliases: p.aliases,
    category: p.category,
    subcategory: p.subcategory,
    count: p.count,
    inMinor: minor(p.inMinor),
    outMinor: minor(p.outMinor),
    lastDate: p.lastDate,
    months: p.months.map((m) => ({ month: m.month, inMinor: minor(m.inMinor), outMinor: minor(m.outMinor) })),
  };
}

export function peopleJson(o: PeopleOverview) {
  return { people: o.people.map(personJson), undo: o.undo ?? null };
}
