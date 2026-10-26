import { NOISE } from "./payees";

// Same values as INCOME_CATEGORY and OWN_TRANSFER in categorize.ts, which imports this module.
const INCOME_CATEGORY = "Income";
const OWN_TRANSFER = "Own transfer";

// Who a bank narration names, matched against the people the owner has told Ledger about.
// Banks cut names off, reorder them and shorten them to initials: "GIFT ADEBAYO OJO" can arrive as
// "OJO GIFT A", "GIFT ADEBAYO OJ" or "TRF TO GIFT". Matching is deterministic and returns a confidence;
// only a confident, unambiguous match is applied on its own. Everything in between goes to Review.

/** At or above this, and clearly ahead of anyone else, a name is applied to the person without asking. */
export const AUTO_MATCH = 0.85;
/** At or above this (but not AUTO_MATCH, or close to someone else), Review asks "Is this <person>?". */
export const REVIEW_MATCH = 0.6;
/** How far the best person must be ahead of the next one to be applied without asking. */
const MARGIN = 0.1;
/** One name word on its own ("TRF TO GIFT") never identifies a person, unless the owner saved that spelling. */
const ONE_WORD_CAP = 0.7;
const INITIAL = 0.6;

export type Relationship = "spouse" | "sibling" | "parent" | "child" | "extended" | "friend" | "vendor" | "colleague" | "me" | "other";

export interface RelationshipInfo {
  value: Relationship;
  /** The answer button. */
  label: string;
  /** In sentences and for the cloud model: "PERSON_1 (spouse)". */
  short: string;
}

export const RELATIONSHIPS: readonly RelationshipInfo[] = [
  { value: "spouse", label: "Spouse / partner", short: "spouse" },
  { value: "sibling", label: "Sibling", short: "sibling" },
  { value: "parent", label: "Parent", short: "parent" },
  { value: "child", label: "Child", short: "child" },
  { value: "extended", label: "Extended family (black tax)", short: "extended family" },
  { value: "friend", label: "Friend", short: "friend" },
  { value: "vendor", label: "Vendor / service provider", short: "vendor" },
  { value: "colleague", label: "Colleague / work", short: "colleague" },
  { value: "me", label: "Me (my own other account)", short: "me" },
  { value: "other", label: "Someone else", short: "someone else" },
];

export const RELATIONSHIP_VALUES: readonly string[] = RELATIONSHIPS.map((r) => r.value);

export function isRelationship(v: unknown): v is Relationship {
  return typeof v === "string" && RELATIONSHIP_VALUES.includes(v);
}

export function relationshipInfo(r: string): RelationshipInfo {
  return RELATIONSHIPS.find((x) => x.value === r) ?? RELATIONSHIPS[RELATIONSHIPS.length - 1];
}

export interface Label {
  category: string;
  subcategory: string | null;
}

/** Vendors default here until the owner says what they buy from them. */
export const VENDOR_DEFAULT: Label = { category: "Shopping", subcategory: "Vendors" };

const MONEY_OUT: Record<Relationship, Label | null> = {
  spouse: { category: "Family", subcategory: "Spouse" },
  sibling: { category: "Family", subcategory: "Siblings" },
  parent: { category: "Family", subcategory: "Parents" },
  child: { category: "Family", subcategory: "Children" },
  extended: { category: "Family", subcategory: "Black tax" },
  friend: { category: "Transfers", subcategory: "Gifts & lending" },
  vendor: VENDOR_DEFAULT,
  colleague: { category: "Business", subcategory: "Business expense" },
  me: { category: OWN_TRANSFER, subcategory: "Between own accounts" },
  other: null,
};

const FROM_FAMILY: Label = { category: INCOME_CATEGORY, subcategory: "From family & friends" };
const MONEY_IN: Record<Relationship, Label | null> = {
  spouse: FROM_FAMILY,
  sibling: FROM_FAMILY,
  parent: FROM_FAMILY,
  child: FROM_FAMILY,
  extended: FROM_FAMILY,
  friend: FROM_FAMILY,
  // What a vendor or colleague sends back (a refund, a reimbursement) is left to the rules.
  vendor: null,
  colleague: null,
  me: { category: OWN_TRANSFER, subcategory: "Between own accounts" },
  other: null,
};

/**
 * The label a relationship gives a payment: deterministic, and ahead of the AI. Null means the
 * relationship says nothing about this direction and the row keeps the label it has.
 */
export function mappingFor(relationship: string, type: string, vendor?: { category?: string | null; subcategory?: string | null }): Label | null {
  if (!isRelationship(relationship)) return null;
  if (type === "CREDIT") return MONEY_IN[relationship];
  if (relationship === "vendor" && vendor?.category) return { category: vendor.category, subcategory: vendor.subcategory ?? null };
  return MONEY_OUT[relationship];
}

/** The relationship an AI label implies, so the model can propose who someone is. The owner confirms. */
export function relationshipForLabel(category: string, subcategory: string | null): Relationship | undefined {
  if (category === OWN_TRANSFER && subcategory === "Between own accounts") return "me";
  if (category === "Transfers" && (subcategory === "Gifts & lending" || subcategory === "Friends")) return "friend";
  if (category !== "Family") return undefined;
  return ({ Spouse: "spouse", Partner: "spouse", Siblings: "sibling", Parents: "parent", Children: "child", "Black tax": "extended" } as Record<string, Relationship>)[subcategory ?? ""];
}

// ---- Names ----

/** Name words, uppercase, without rails, banks, legal forms or titles. Single letters are kept as initials. */
export function nameWords(name: string): string[] {
  return name.toUpperCase().split(/[^A-Z]+/).filter((t) => t && !NOISE.has(t.toLowerCase()));
}

/** One key per spelling, whatever the word order: "OJO GIFT A" and "A GIFT OJO" share "A GIFT OJO". */
export function aliasKey(name: string): string {
  return [...nameWords(name)].sort().join(" ");
}

function wordScore(c: string, a: string): number {
  if (c === a) return 1;
  if (c.length === 1 || a.length === 1) return c[0] === a[0] ? INITIAL : 0;
  // The narration cut the word off ("OJ" for "OJO", "CHUKWUEMEK" for "CHUKWUEMEKA").
  if (c.length >= 3 && a.startsWith(c)) return 0.9;
  if (c.length === 2 && a.startsWith(c)) return INITIAL;
  // The saved spelling was the cut-off one. "GIFTY" may be someone else than "GIFT", so it counts for less.
  if (a.length >= 3 && c.startsWith(a)) return 0.75;
  return 0;
}

/**
 * How sure Ledger is that `candidate` (as a bank wrote it) is the person saved as `known`, from 0 to 1.
 * Token-set matching: words in any order, cut-off words and initials count for less, words in the
 * narration that the known name lacks count against it, and one word alone is capped below AUTO_MATCH.
 */
export function nameScore(candidate: string, known: string): number {
  const c = nameWords(candidate), a = nameWords(known);
  if (!c.length || !a.length) return 0;
  if (c.join("") === a.join("") || [...c].sort().join(" ") === [...a].sort().join(" ")) return 1;
  const pairs: { i: number; j: number; s: number }[] = [];
  c.forEach((cw, i) => a.forEach((aw, j) => {
    const s = wordScore(cw, aw);
    if (s > 0) pairs.push({ i, j, s });
  }));
  pairs.sort((x, y) => y.s - x.s);
  const usedC = new Set<number>(), usedA = new Set<number>();
  let sum = 0, strong = 0;
  for (const p of pairs) {
    if (usedC.has(p.i) || usedA.has(p.j)) continue;
    usedC.add(p.i);
    usedA.add(p.j);
    sum += p.s;
    if (p.s >= 0.75) strong++;
  }
  if (!strong) return 0;
  let score = (sum / c.length) * (0.7 + 0.3 * (usedA.size / a.length));
  if (strong === 1 && usedA.size === 1) score = Math.min(score, ONE_WORD_CAP);
  return Math.round(score * 1000) / 1000;
}

/** Two spellings in the ledger that are confidently the same (unknown) person, for grouping questions. */
export function sameIndividual(a: string, b: string): boolean {
  return Math.max(nameScore(a, b), nameScore(b, a)) >= AUTO_MATCH;
}

export interface KnownAlias {
  name: string;
  key: string;
  rejected?: boolean;
}

export interface KnownPerson {
  id: string;
  displayName: string;
  relationship: string;
  vendorCategory?: string | null;
  vendorSubcategory?: string | null;
  aliases: KnownAlias[];
}

export interface PersonMatch {
  status: "match" | "ambiguous" | "none";
  /** Set when status is "match". */
  personId?: string;
  confidence: number;
  /** Everyone at or above REVIEW_MATCH, best first. */
  candidates: { personId: string; confidence: number }[];
}

/** The score for one person: their best saved spelling, unless the owner said this spelling is not them. */
export function personScore(name: string, p: KnownPerson): number {
  const key = aliasKey(name);
  if (!key) return 0;
  if (p.aliases.some((a) => a.rejected && a.key === key)) return 0;
  const kept = p.aliases.filter((a) => !a.rejected);
  if (kept.some((a) => a.key === key)) return 1;
  return Math.max(nameScore(name, p.displayName), ...kept.map((a) => nameScore(name, a.name)));
}

/** Which known person a narration name is, if any. Close calls between two people are "ambiguous". */
export function matchPeople(name: string | null | undefined, people: readonly KnownPerson[]): PersonMatch {
  if (!name || !people.length) return { status: "none", confidence: 0, candidates: [] };
  const scored = people.map((p) => ({ personId: p.id, confidence: personScore(name, p) })).sort((x, y) => y.confidence - x.confidence);
  const candidates = scored.filter((s) => s.confidence >= REVIEW_MATCH);
  const [best, second] = scored;
  if (!best || best.confidence < REVIEW_MATCH) return { status: "none", confidence: best?.confidence ?? 0, candidates: [] };
  const clear = !second || best.confidence - second.confidence >= MARGIN;
  if (best.confidence >= AUTO_MATCH && clear) return { status: "match", personId: best.personId, confidence: best.confidence, candidates };
  return { status: "ambiguous", confidence: best.confidence, candidates };
}

// ---- "My wife is Gift Adebayo Ojo" ----

const WORD_RELATIONSHIP: [RegExp, Relationship][] = [
  [/^(wife|husband|spouse|partner|fianc[eé]e?|hubby|missus|bae)$/, "spouse"],
  [/^(brother|sister|sibling|bro|sis|twin)s?$/, "sibling"],
  [/^(mum|mom|mother|mummy|mommy|mama|dad|father|daddy|papa|parent)s?$/, "parent"],
  [/^(son|daughter|child|kid|baby)s?$|^children$/, "child"],
  [/^(aunt|aunty|auntie|uncle|cousin|niece|nephew|grand(ma|pa|mother|father|mum|dad)|granny|in-?law|(mother|father|brother|sister)-?in-?law|relative|extended family)s?$/, "extended"],
  [/^(friend|bestie|buddy|bff|guy|babe)s?$/, "friend"],
  [/^(colleague|coworker|co-worker|boss|manager|employer|client|business partner)s?$/, "colleague"],
  [/^(driver|tailor|cleaner|nanny|cook|chef|mechanic|landlord|landlady|plumber|electrician|gardener|maid|house ?help|barber|hairdresser|stylist|vendor|supplier|caterer|gateman|security)s?$/, "vendor"],
];

const VENDOR_WORDS: [RegExp, Label][] = [
  [/driver|cleaner|nanny|cook|chef|maid|house ?help|gardener|gateman|security|plumber|electrician/, { category: "Housing", subcategory: "Home services" }],
  [/landlord|landlady/, { category: "Housing", subcategory: "Rent" }],
  [/tailor/, { category: "Shopping", subcategory: "Clothing" }],
  [/barber|hairdresser|stylist/, { category: "Shopping", subcategory: "Personal care" }],
  [/mechanic/, { category: "Transport", subcategory: "Car" }],
  [/caterer/, { category: "Food", subcategory: "Eating out" }],
];

export interface ParsedPerson {
  name: string;
  relationship: Relationship;
  /** The owner's word for them ("wife", "brother"), kept as the note. */
  word: string;
  vendor?: Label;
}

function relationshipOf(word: string): Relationship | undefined {
  const w = word.toLowerCase().replace(/\s+/g, " ").trim();
  return WORD_RELATIONSHIP.find(([re]) => re.test(w))?.[1];
}

const cleanPersonName = (s: string) => s.replace(/[^A-Za-z .'-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

/**
 * Reads lines like "My wife is Gift Adebayo Ojo", "my brother: Tunde Ojo" or "Ngozi Okafor is my aunty".
 * Lines it cannot read are returned as unread so the owner can fix them.
 */
export function parsePeopleText(text: string): { people: ParsedPerson[]; unread: string[] } {
  const people: ParsedPerson[] = [];
  const unread: string[] = [];
  for (const raw of text.split(/[\n;]+/)) {
    const line = raw.replace(/\.$/, "").trim();
    if (!line) continue;
    const a = line.match(/^(?:my|our)\s+([a-z -]+?)(?:'s name)?\s*(?:\bis\b|\bare\b|:|=|-)\s*(.+)$/i);
    const b = line.match(/^(.+?)\s+is\s+(?:my|our)\s+([a-z -]+)$/i);
    const word = a ? a[1] : b ? b[2] : "";
    const name = cleanPersonName(a ? a[2] : b ? b[1] : "");
    const relationship = word ? relationshipOf(word) : undefined;
    if (!relationship || nameWords(name).length < 1) {
      unread.push(line);
      continue;
    }
    const vendor = relationship === "vendor" ? VENDOR_WORDS.find(([re]) => re.test(word.toLowerCase()))?.[1] : undefined;
    people.push({ name, relationship, word: word.toLowerCase().trim(), ...(vendor && { vendor }) });
  }
  return { people, unread };
}
