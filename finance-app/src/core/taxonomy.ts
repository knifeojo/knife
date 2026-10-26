import { ALL_CATEGORIES, INCOME_CATEGORY, INCOME_SUBCATEGORIES, OWN_TRANSFER } from "./categorize";

// The category / subcategory pairs Ledger's rules and Review answers produce. Anything that labels
// a transaction from outside the rules (the AI) must pick from this list; a subcategory may also be empty.
export const TAXONOMY: Readonly<Record<string, readonly string[]>> = {
  Food: ["Groceries", "Eating out", "Delivery"],
  Transport: ["Ride hailing", "Public transport", "Interstate bus", "Fuel", "Tolls", "Parking", "Car", "Delivery"],
  Housing: ["Rent", "Home services", "Home & furnishing", "Generator & diesel", "Air conditioning", "Light and service charge", "Staff"],
  Utilities: ["Electricity", "Internet", "Airtime & data", "TV"],
  Shopping: ["Clothing", "Personal care", "Electronics", "Online", "Online payment", "Card purchase", "Vendors", "Services"],
  Subscriptions: ["Streaming", "Software"],
  Family: ["Family support", "Spouse", "Partner", "Siblings", "Parents", "Children", "Black tax", "Education", "Gifts"],
  Giving: ["Church", "Tithe", "Offering", "Charity"],
  Debt: ["Loan repayment", "Loans", "Loan proceeds"],
  Healthcare: ["Fitness"],
  Travel: [],
  Business: ["Business expense", "Tax & compliance", "Insurance"],
  Transfers: ["Friends", "Gifts & lending", "Withdrawal"],
  Fees: ["Refund", "Advance fee"],
  Other: ["Cash", "Betting"],
  [INCOME_CATEGORY]: [...INCOME_SUBCATEGORIES, "Gifts received", "From family & friends"],
  [OWN_TRANSFER]: ["Between own accounts", "Savings", "Wallet top-up", "Between your wallets", "Currency conversion"],
};

/**
 * The canonical pair for a proposed label, or undefined when it is not in the taxonomy.
 * Matching ignores case and surrounding space; an empty subcategory means "none".
 */
export function canonicalLabel(category: unknown, subcategory: unknown): { category: string; subcategory: string | null } | undefined {
  if (typeof category !== "string") return undefined;
  const cat = ALL_CATEGORIES.find((c) => c.toLowerCase() === category.trim().toLowerCase());
  if (!cat) return undefined;
  if (subcategory === null || subcategory === undefined || (typeof subcategory === "string" && !subcategory.trim())) return { category: cat, subcategory: null };
  if (typeof subcategory !== "string") return undefined;
  const sub = TAXONOMY[cat]?.find((s) => s.toLowerCase() === subcategory.trim().toLowerCase());
  return sub ? { category: cat, subcategory: sub } : undefined;
}

/**
 * Labels only a deterministic rule may give: bank fees, wallet withdrawals, and own transfers the
 * pairing logic proves. A model that cannot see both accounts must not propose them.
 */
const RULE_ONLY: Readonly<Record<string, readonly string[] | "all">> = {
  Fees: "all",
  Transfers: ["Withdrawal"],
  [OWN_TRANSFER]: ["Between your wallets", "Currency conversion"],
};

export function ruleOnly(category: string, subcategory: string | null): boolean {
  const r = RULE_ONLY[category];
  return r === "all" || (!!r && !!subcategory && r.includes(subcategory));
}

/** Categories a model may propose. */
export const AI_CATEGORIES: readonly string[] = ALL_CATEGORIES.filter((c) => RULE_ONLY[c] !== "all");

/** "Family: Family support, Partner, …" one line per category a model may use, for prompts. */
export function taxonomyText(): string {
  return AI_CATEGORIES.map((c) => {
    const subs = (TAXONOMY[c] ?? []).filter((s) => !ruleOnly(c, s));
    return `${c}: ${subs.length ? subs.join(", ") : "(no subcategory)"}`;
  }).join("\n");
}
