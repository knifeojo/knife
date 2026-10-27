import data from "../../../data/merchants-ng.json";

// The seeded merchant directory (data/merchants-ng.json): Nigerian merchants, billers, wallets,
// lenders and savings apps the categorizer knows by name. It runs after the owner's own rules and
// Ledger's hand-written rules, and before any AI, so the model only ever sees true unknowns.

export type MerchantKind =
  | "telco" | "isp" | "electricity" | "bills" | "tv" | "waste" | "water" | "subscription" | "ride" | "transport" | "fuel"
  | "toll" | "government" | "logistics" | "delivery" | "restaurant" | "supermarket" | "shopping" | "pharmacy" | "hmo"
  | "health" | "fitness" | "betting" | "lender" | "savings" | "wallet" | "gateway" | "pos" | "airline" | "travel"
  | "insurance" | "church" | "religious" | "education";

export interface MerchantEntry {
  name: string;
  kind: MerchantKind;
  category: string;
  subcategory?: string;
  /** Lowercase words, matched whole against the narration. */
  aliases: string[];
}

export interface MerchantDirectory {
  version: number;
  updated: string;
  merchants: MerchantEntry[];
}

export const DIRECTORY: MerchantDirectory = data as MerchantDirectory;

/** Lowercase, punctuation to spaces (dots kept inside words like "max.ng"), single spaces, padded. */
export function directoryText(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9.]+/g, " ").replace(/\.(?=\s|$)|(?:^|\s)\./g, " ").replace(/\s+/g, " ").trim()} `;
}

interface Compiled {
  entry: MerchantEntry;
  /** " jendol " and, for multi-word aliases, the run-together spelling " ikejaelectric ". */
  needles: string[];
  length: number;
}

function compile(entries: MerchantEntry[]): Compiled[] {
  const out: Compiled[] = [];
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      const spaced = directoryText(alias);
      const joined = spaced.replace(/ /g, "");
      const needles = [spaced, ...(spaced.trim().includes(" ") && joined.length >= 8 ? [` ${joined} `] : [])];
      out.push({ entry, needles, length: spaced.trim().length });
    }
  }
  // The longest alias wins: "moniepoint pos" before "moniepoint", "leadway health" before "leadway".
  return out.sort((a, b) => b.length - a.length);
}

const COMPILED = compile(DIRECTORY.merchants);

export interface DirectoryHit {
  entry: MerchantEntry;
  alias: string;
}

/** The directory entry a text names, if any. */
export function matchDirectory(text: string | null | undefined): DirectoryHit | undefined {
  if (!text) return undefined;
  const t = directoryText(text);
  for (const c of COMPILED) {
    const needle = c.needles.find((n) => t.includes(n));
    if (needle) return { entry: c.entry, alias: needle.trim() };
  }
  return undefined;
}

// Words a business name carries besides its brand ("JENDOL SUPERSTORES LTD", "IKEJA ELECTRIC PLC").
const BUSINESS_WORDS = new Set([
  "ltd", "limited", "plc", "inc", "llc", "nigeria", "nig", "ng", "nga", "co", "company", "group", "intl", "international",
  "stores", "store", "superstores", "superstore", "supermarket", "supermarkets", "mart", "enterprises", "enterprise",
  "services", "global", "holdings", "technologies", "tech", "payments", "payment", "africa", "west", "the", "and", "of",
  "mfb", "microfinance", "bank", "psb", "bills", "online", "app", "pos", "merchant",
]);

/**
 * True when every word of a name is the brand or a business word: "Jendol Superstores Ltd" names
 * Jendol, but "Bolaji Glo Adeyemi" is a person whose name happens to contain a brand.
 */
export function namesOnlyBusiness(name: string, alias: string): boolean {
  const brand = new Set(directoryText(alias).trim().split(" "));
  const joined = directoryText(alias).replace(/ /g, "");
  return directoryText(name).trim().split(" ").every((w) => brand.has(w) || w === joined || BUSINESS_WORDS.has(w));
}

/** True when a name is a known business from the directory ("Jendol Superstores", "Ikeja Electric"). */
export function isDirectoryBusiness(name: string | null | undefined): boolean {
  if (!name) return false;
  const hit = matchDirectory(name);
  return !!hit && namesOnlyBusiness(name, hit.alias);
}
