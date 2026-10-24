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
  Family: ["Family support", "Partner", "Parents", "Black tax", "Education", "Gifts"],
  Giving: ["Church", "Tithe", "Offering", "Charity"],
  Debt: ["Loan repayment", "Loans", "Loan proceeds"],
  Healthcare: ["Fitness"],
  Travel: [],
  Business: ["Business expense", "Tax & compliance", "Insurance"],
  Transfers: ["Friends", "Withdrawal"],
  Fees: ["Refund", "Advance fee"],
  Other: ["Cash", "Betting"],
  [INCOME_CATEGORY]: [...INCOME_SUBCATEGORIES, "Gifts received"],
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

/** "Family: Family support, Partner, …" one line per category, for model prompts. */
export function taxonomyText(): string {
  return ALL_CATEGORIES.map((c) => `${c}: ${TAXONOMY[c]?.length ? TAXONOMY[c].join(", ") : "(no subcategory)"}`).join("\n");
}
