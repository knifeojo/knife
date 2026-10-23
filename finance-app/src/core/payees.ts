// Who a payment went to, matched across the many ways Nigerian narrations write the same person or shop:
// "TO OPAY - CHIDI EMEKA OKEKE", "NIP TRANSFER TO PALMPAY - OKEKE CHIDI", "TRF/CHIDI E OKEK", "POS SHOPRITE LEKKI",
// "POS/WEB PMNT @ SHOPRITE IKEJA CITY MALL LA NG", "TO SHOPRITE NIGERIA LTD". Deterministic: no AI involved.

/** Words that say how or where money moved, not who received it. */
const NOISE = new Set([
  // rails, wallets and banks that sit next to the name
  "opay", "palmpay", "moniepoint", "monie", "kuda", "paystack", "flutterwave", "paga", "vfd", "vbank", "mfb", "psb", "bank", "microfinance",
  "nip", "fip", "trf", "transfer", "payment", "pmnt", "pmt", "pos", "web", "purchase", "purch", "ussd", "mob", "utu", "outward", "inward", "instant",
  "to", "from", "frm", "via", "ref", "for", "and", "the", "of",
  // legal forms
  "ltd", "limited", "plc", "inc", "llc", "nig", "nigeria", "ng", "nga", "enterprise", "enterprises", "venture", "ventures", "global",
  "concept", "concepts", "company", "co", "intl", "international", "technologies", "technology", "tech",
  // branches and places on POS lines
  "la", "lag", "lagos", "lekki", "ikeja", "vi", "ikoyi", "yaba", "surulere", "ajah", "abuja", "abj", "ph", "ibadan", "kano",
  "mall", "city", "branch", "outlet", "com", "www", "app",
  // titles
  "mr", "mrs", "ms", "miss", "dr", "chief", "alhaji", "alhaja", "hajia", "pastor", "engr", "prof", "barr", "sir", "madam",
]);

/** Name words that identify the payee, lowercase, with rails, legal forms, branches and titles removed. */
export function payeeTokens(name: string): string[] {
  const raw = name.toLowerCase().replace(/[^a-z]+/g, " ").split(" ").filter((t) => t.length >= 2);
  const kept = raw.filter((t) => !NOISE.has(t));
  return kept.length ? kept : raw;
}

/** Stable key for one name variant: "SHOPRITE NIGERIA LTD" and "Shoprite Lekki" both give "shoprite". */
export function payeeKey(name: string): string {
  return payeeTokens(name).join(" ");
}

// Statements cut names off ("OKEK", "CHUKWUEMEK"): a word of 4+ letters may match the start of a longer one.
const tokenMatch = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/**
 * Same person or business. People: one name's words are all in the other's (any order, cut-off words allowed),
 * or two of three match. A one-word business name ("Shoprite", "Bolt") matches a longer name that starts with it.
 * Words run together ("CHICKENREPUBLIC") match the spaced spelling.
 */
export function samePayee(a: string, b: string): boolean {
  const ta = payeeTokens(a), tb = payeeTokens(b);
  if (!ta.length || !tb.length) return false;
  if (ta.join("") === tb.join("")) return true;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (small.length === 1) return small[0].length >= 4 && tokenMatch(small[0], big[0]);
  const shared = small.filter((t) => big.some((u) => tokenMatch(t, u))).length;
  if (shared === small.length) return true;
  // Two-word names must match fully: a shared surname alone would merge different relatives.
  return small.length >= 3 && shared >= small.length - 1 && shared >= 2;
}

/** The name a payment is matched on: the person or shop paid, else nothing (memo-only or unnamed). */
export function payeeName(r: { counterparty: string | null; merchantName: string | null }): string | null {
  const name = r.counterparty ?? r.merchantName;
  return name && payeeTokens(name).length ? name : null;
}

export interface PayeeAlias {
  pattern: string;
  canonicalName: string;
  category: string | null;
  subcategory: string | null;
}

export interface PayeeCluster<T> {
  /** What the user called them (a learned rule), else the most common spelling. */
  name: string;
  /** The user's own label from Review or a correction ("Mum", "Landlord"), if any. */
  label: string | null;
  /** The learned rule that named this payee, if any. */
  alias: PayeeAlias | null;
  variants: string[];
  items: T[];
}

/**
 * Groups items by the payee they name, matching spellings with samePayee. Learned rules (MerchantAlias) name
 * the group, so after the user answers "Who is Chidi Emeka Okeke?" every spelling of Chidi shows as one line.
 */
export function clusterPayees<T>(items: T[], nameOf: (item: T) => string | null, aliases: PayeeAlias[] = []): { clusters: PayeeCluster<T>[]; unnamed: T[] } {
  const clusters: (PayeeCluster<T> & { counts: Map<string, number> })[] = [];
  const unnamed: T[] = [];
  for (const item of items) {
    const name = nameOf(item);
    if (!name) {
      unnamed.push(item);
      continue;
    }
    let c = clusters.find((x) => x.variants.some((v) => v === name || samePayee(v, name)));
    if (!c) clusters.push((c = { name, label: null, alias: null, variants: [], items: [], counts: new Map() }));
    if (!c.variants.includes(name)) c.variants.push(name);
    c.counts.set(name, (c.counts.get(name) ?? 0) + 1);
    c.items.push(item);
  }
  const learned = aliases.filter((a) => a.category && a.canonicalName);
  return {
    clusters: clusters.map(({ counts, ...c }) => {
      const alias = learned.find((a) => c.variants.some((v) => samePayee(a.pattern, v) || samePayee(a.canonicalName, v)));
      const common = [...counts.entries()].sort((x, y) => y[1] - x[1] || y[0].length - x[0].length)[0][0];
      return { ...c, name: alias?.canonicalName ?? common, label: alias?.subcategory ?? null, alias: alias ?? null };
    }),
    unnamed,
  };
}
