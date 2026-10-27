import { formatMoney } from "@/lib/money";
import { nameWords, type KnownPerson } from "./people-match";

// Rule-based guesses about who an unknown individual is, worked out on this machine from the
// owner's own data (nothing is sent anywhere). A guess is only ever a proposal on a Review
// question: nothing is relabelled until the owner taps it, and the tap is the same answer as
// picking the relationship by hand, so it applies to past and future payments and can be undone.

export type GuessKind = "same_surname" | "regular" | "two_way";

/** One tap on a guess. Sent as a Review answer: value `rel:<relationship>`, plus the vendor label for rent or staff. */
export interface GuessAnswer {
  value: string;
  label: string;
  vendorCategory?: string;
  vendorSubcategory?: string;
}

export interface PeopleGuess {
  kind: GuessKind;
  /** Why Ledger thinks so, in plain words. */
  reason: string;
  answers: GuessAnswer[];
}

const FAMILY_ANSWERS: GuessAnswer[] = [
  { value: "rel:sibling", label: "Sibling" },
  { value: "rel:parent", label: "Parent" },
  { value: "rel:child", label: "Child" },
  { value: "rel:extended", label: "Extended family" },
];

const REGULAR_ANSWERS: GuessAnswer[] = [
  { value: "rel:vendor", label: "Rent", vendorCategory: "Housing", vendorSubcategory: "Rent" },
  { value: "rel:extended", label: "Family support" },
  { value: "rel:vendor", label: "Staff salary", vendorCategory: "Housing", vendorSubcategory: "Staff" },
];

const TWO_WAY_ANSWERS: GuessAnswer[] = [{ value: "rel:friend", label: "Friend" }];

// Titles and honorifics in narrations ("MRS ADA EZE", "ALH. MUSA") that are not names.
const TITLES = new Set(["MR", "MRS", "MISS", "MS", "DR", "CHIEF", "ALH", "ALHAJI", "ALHAJA", "PASTOR", "ENGR", "PROF", "SIR", "MADAM", "AUNTY", "UNCLE", "BARR", "HON"]);

/** Name words without rails, banks, titles or initials: "TRF/MRS EZE C. ADAOBI" -> EZE, ADAOBI. */
export function personWords(name: string): string[] {
  return nameWords(name).filter((w) => w.length >= 2 && !TITLES.has(w));
}

/**
 * The owner's family surname(s). The owner's own name is written "First Last", so its last word;
 * banks often write the holder surname first, so a holder name only counts through words it shares
 * with a parent or sibling the owner named (or, with no family named, its first and last words).
 */
export function familySurnames(ownName: string | null | undefined, holderNames: string[], people: KnownPerson[]): string[] {
  const out = new Set<string>();
  const own = ownName ? personWords(ownName) : [];
  if (own.length >= 2) out.add(own[own.length - 1]);
  const kin = people.filter((p) => p.relationship === "parent" || p.relationship === "sibling" || p.relationship === "me")
    .flatMap((p) => [p.displayName, ...p.aliases.filter((a) => !a.rejected).map((a) => a.name)]);
  const kinWords = new Set(kin.flatMap(personWords));
  for (const n of [ownName ?? "", ...holderNames]) for (const w of personWords(n)) if (kinWords.has(w) && w.length >= 3) out.add(w);
  if (!out.size) {
    for (const h of holderNames) {
      const words = personWords(h);
      if (words.length >= 2) [words[0], words[words.length - 1]].forEach((w) => out.add(w));
    }
  }
  return [...out].filter((w) => w.length >= 3);
}

/**
 * The surname a name shares with the owner, in any position (narrations put the surname first or
 * last). Banks cut long names short, so the last word may be the start of the surname ("OKONKW").
 */
export function sharedSurname(name: string, surnames: string[]): string | undefined {
  const words = personWords(name);
  if (words.length < 2) return undefined;
  return surnames.find((s) => words.includes(s) || words.some((w) => w.length >= 4 && w.length < s.length && s.startsWith(w)));
}

export interface GuessInput {
  name: string;
  inCount: number;
  outCount: number;
  /** For a regular payment: about how much and on what day. */
  regular?: { typicalMinor: bigint; day: number; months: number };
  surnames: string[];
}

/** The strongest guess for one individual: same surname, then a fixed monthly payment, then money both ways. */
export function guessFor(g: GuessInput): PeopleGuess | undefined {
  const surname = sharedSurname(g.name, g.surnames);
  if (surname) {
    const s = surname[0] + surname.slice(1).toLowerCase();
    return { kind: "same_surname", reason: `They share your surname, ${s}. Family?`, answers: FAMILY_ANSWERS };
  }
  if (g.regular && g.inCount === 0) {
    return {
      kind: "regular",
      reason: `You send about ${formatMoney(g.regular.typicalMinor)} every month (${g.regular.months} months). Usually rent, family support or someone you employ.`,
      answers: REGULAR_ANSWERS,
    };
  }
  if (g.inCount > 0 && g.outCount > 0) {
    return { kind: "two_way", reason: "Money goes both ways between you. A friend?", answers: TWO_WAY_ANSWERS };
  }
  return undefined;
}
