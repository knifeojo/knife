import type { Account, Transaction } from "@prisma/client";
import { cadenceOf, type CadenceIndex } from "@/core/cadence";

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
export function transactionJson(tx: TxWithAccount, cadence?: CadenceIndex) {
  const kind = cadence ? cadenceOf(tx, cadence) : undefined;
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
    ...(cadence && { cadence: kind ?? null, recurringBill: kind === "recurring" && !!cadence.recurring.get(tx.id)?.bill }),
  };
}
