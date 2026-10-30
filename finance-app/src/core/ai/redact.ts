import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { COMPANY, canonicalLender, nameHint, nameTokens, normalizeMerchant, sameName } from "../categorize";
import { isDirectoryBusiness } from "../merchants/directory";
import { relationshipInfo } from "../people-match";

// The privacy layer for every request that leaves this machine. Cloud call sites build their payload,
// pass every string through a Redactor, and map the answer back with restore(). Local (Ollama) calls
// do not use this module beyond redactNarration; they stay on localhost.
//
// What a Redactor removes:
// - emails, phone numbers, card numbers (plain, spaced or masked), masked and 10-digit account
//   numbers, 11-digit BVN/NIN-like ids, and any other run of 6+ digits
// - the owner's own name (user name and account holder names) -> OWNER
// - names of people (payees and senders that look like a person, not a business) -> PERSON_1, PERSON_2…
//   numbered in order of first appearance, stable for the Redactor's lifetime, mapped back by restore()
// Amounts are rounded (chat, insights) or bucketed (categorization) by the helpers below.

/** Local path: long digit runs (account numbers, session ids) removed. */
export function redactNarration(s: string): string {
  return s.replace(/\d{6,}/g, "#").replace(/\s+/g, " ").trim().slice(0, 200);
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const MASKED_CARD = /(?<!\d)\d{4,6}[*xX•]{3,}\d{3,4}(?!\d)/g;
const SPACED_CARD = /(?<!\d)\d{4}(?:[ -]\d{4}){2,3}(?:[ -]\d{1,3})?(?!\d)/g;
const NG_PHONE = /(?:\+?234[\s-]?|(?<!\d)0)[789][01]\d(?:[\s-]?\d){7}(?!\d)/g;
const INTL_PHONE = /\+\d{1,3}[\s-]?\d(?:[\s-]?\d){6,12}(?!\d)/g;
const MASKED_ACCOUNT = /(?<![A-Za-z])[*xX•]{2,}\d{2,6}(?!\d)/g;
const DIGITS = /(?<!\d)\d{6,}(?!\d)/g;

/** Masks identifiers by kind, so the model still knows something was there. */
export function maskIdentifiers(s: string): string {
  return s
    .replace(EMAIL, "[EMAIL]")
    .replace(MASKED_CARD, "[CARD]")
    .replace(SPACED_CARD, "[CARD]")
    .replace(NG_PHONE, "[PHONE]")
    .replace(INTL_PHONE, "[PHONE]")
    .replace(MASKED_ACCOUNT, "[ACCOUNT]")
    .replace(DIGITS, (d) => (d.length === 10 ? "[ACCOUNT]" : d.length === 11 ? "[ID]" : d.length >= 13 && d.length <= 19 && luhn(d) ? "[CARD]" : "[NUMBER]"));
}

// ---- Amounts ----

/** Three significant figures in whole units: 198361100n (₦1,983,611.00) -> 198000000n (₦1,980,000). */
export function roundMinor(minor: bigint): bigint {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const digits = (abs / 100n).toString().length;
  const f = digits > 3 ? 10n ** BigInt(digits - 3) * 100n : 100n;
  const rounded = ((abs + f / 2n) / f) * f;
  return neg ? -rounded : rounded;
}

export function roundedMoney(minor: bigint, currency = "NGN"): string {
  return formatMoney(roundMinor(minor), currency).replace(/\.00$/, "");
}

const BUCKETS = [1_000n, 5_000n, 20_000n, 50_000n, 100_000n, 250_000n, 500_000n, 1_000_000n, 5_000_000n];

/** A range instead of the amount, for categorization: "₦100,000 to ₦250,000". */
export function amountBucket(minor: bigint, currency = "NGN"): string {
  const major = (minor < 0n ? -minor : minor) / 100n;
  const fmt = (b: bigint) => roundedMoney(b * 100n, currency);
  const i = BUCKETS.findIndex((b) => major < b);
  if (i === 0) return `under ${fmt(BUCKETS[0])}`;
  if (i < 0) return `over ${fmt(BUCKETS[BUCKETS.length - 1])}`;
  return `${fmt(BUCKETS[i - 1])} to ${fmt(BUCKETS[i])}`;
}

const SYMBOL_CURRENCY: Record<string, string> = { "₦": "NGN", "CA$": "CAD", $: "USD", "£": "GBP", "€": "EUR" };
const MONEY = /(-?)(₦|CA\$|\$|£|€|(?:NGN|USD|GBP|EUR|CAD|KES|GHS|ZAR) )(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;

function toMinor(whole: string, frac: string | undefined, sign: string): bigint {
  const m = BigInt(whole.replace(/,/g, "")) * 100n + BigInt((frac ?? "0").padEnd(2, "0"));
  return sign ? -m : m;
}

const currencyOf = (sym: string) => SYMBOL_CURRENCY[sym] ?? sym.trim();

/** Rounds every formatted amount in a string to three significant figures. */
export function roundMoneyInText(s: string): string {
  return s.replace(MONEY, (_, sign: string, sym: string, whole: string, frac?: string) => roundedMoney(toMinor(whole, frac, sign), currencyOf(sym)));
}

/** Replaces every formatted amount in a string with its range. */
export function bucketMoneyInText(s: string): string {
  return s.replace(MONEY, (_, sign: string, sym: string, whole: string, frac?: string) => amountBucket(toMinor(whole, frac, sign), currencyOf(sym)));
}

// ---- Names ----

const NOT_PERSON = /\b(mfb|bank|psb|microfinance|wallet|account|acct|savings|opay|palmpay|kuda|moniepoint|paystack|flutterwave|paga|transfer|payment|pos|web|airtime|data|bills?|charges?|fees?|vat|levy|interest|salary|payroll|deposit|reversal|refund|nip|trf|ussd|unnamed)\b/i;

/** A payee or sender that reads like a person (two to five name words, no business or bank words). */
export function looksLikePerson(name: string | null | undefined): boolean {
  if (!name || /\d/.test(name)) return false;
  const tokens = nameTokens(name);
  if (tokens.length < 2 || tokens.length > 5) return false;
  return !(COMPANY.test(name) || NOT_PERSON.test(name) || nameHint(name) || normalizeMerchant(name) || canonicalLender(name) || isDirectoryBusiness(name));
}

const STOP_TOKENS = new Set(["THE", "AND", "FOR", "FROM", "VIA", "MRS", "MISS", "MR", "DR", "CHIEF", "ALHAJI", "ALHAJA", "PASTOR", "ENGR", "PROF", "SIR", "MADAM", "AUNTY", "UNCLE"]);

interface Person {
  display: string;
  owner: boolean;
  /** Each spelling as name words, e.g. ["NGOZI", "CHINWE"]. */
  spellings: string[][];
  placeholder?: string;
  /** Who they are to the owner ("spouse"), when the owner said so. Sent beside the placeholder. */
  label?: string;
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const keyOf = (tokens: string[]) => tokens.join(" ");

export interface RedactorSeed {
  /** The owner's own names: user name and account holder names. */
  owners?: string[];
  /** Names that may be people (payees, senders, labelled names). Businesses are ignored. */
  people?: string[];
  /** The owner's own account labels ("Ada Main Salary Account"). Sent as ACCOUNT_1, ACCOUNT_2… */
  accounts?: string[];
  /** People the owner identified, every spelling with their relationship: sent as "PERSON_1 (spouse)". */
  known?: KnownName[];
}

export interface KnownName {
  names: string[];
  /** Short relationship label, e.g. "spouse", "extended family". */
  relationship: string;
}

export class Redactor {
  private people: Person[] = [];
  private byPlaceholder = new Map<string, Person>();
  private next = 1;
  private accounts = new Map<string, { label: string; placeholder: string }>();
  private nextAccount = 1;
  private accountsByPlaceholder = new Map<string, string>();
  private matcher?: { full: RegExp; fullMap: Map<string, Person>; token?: RegExp; tokenMap: Map<string, Person> };

  constructor(seed: RedactorSeed = {}) {
    for (const o of seed.owners ?? []) this.add(o, true);
    for (const k of seed.known ?? []) this.addKnown(k);
    for (const p of seed.people ?? []) this.add(p);
    const labels = [...new Set((seed.accounts ?? []).map((a) => a.trim()).filter((a) => a.length >= 3))].sort((a, b) => b.length - a.length);
    labels.forEach((label) => this.accounts.set(label.toUpperCase(), { label, placeholder: "" }));
  }

  /** Registers a name. Owners always; others only when they look like a person. */
  add(name: string | null | undefined, owner = false): void {
    if (!name) return;
    if (!owner && !looksLikePerson(name)) return;
    const tokens = nameTokens(name);
    if (!tokens.length) return;
    const existing =
      this.people.find((p) => p.owner && p.spellings.some((s) => sameName(keyOf(s), name) || keyOf(s) === keyOf(tokens))) ??
      this.people.find((p) => p.owner === owner && p.spellings.some((s) => sameName(keyOf(s), name) || keyOf(s) === keyOf(tokens)));
    if (existing) {
      if (!existing.spellings.some((s) => keyOf(s) === keyOf(tokens))) existing.spellings.push(tokens);
    } else {
      this.people.push({ display: titleCase(tokens.join(" ")), owner, spellings: [tokens] });
    }
    this.matcher = undefined;
  }

  /** Registers someone the owner identified. Every spelling is one placeholder, labelled with the relationship. */
  addKnown(k: KnownName): void {
    const spellings = k.names.map(nameTokens).filter((t) => t.length);
    if (!spellings.length) return;
    let p = this.people.find((x) => !x.owner && x.spellings.some((s) => spellings.some((t) => keyOf(s) === keyOf(t) || sameName(keyOf(s), keyOf(t)))));
    if (!p) this.people.push((p = { display: titleCase(spellings[0].join(" ")), owner: false, spellings: [] }));
    for (const t of spellings) if (!p.spellings.some((s) => keyOf(s) === keyOf(t))) p.spellings.push(t);
    p.label = k.relationship.replace(/[^a-z &-]/gi, "").trim() || undefined;
    this.matcher = undefined;
  }

  /** "PERSON_1 (spouse)" for a registered name, straight from the registry (no text matching). */
  placeholderOfName(name: string): string | undefined {
    const key = keyOf(nameTokens(name));
    const p = this.people.find((x) => x.spellings.some((s) => keyOf(s) === key));
    return p ? this.tagged(p) : undefined;
  }

  /** The placeholder as sent: "PERSON_1 (spouse)" for someone the owner identified. */
  private tagged(p: Person): string {
    const ph = this.placeholderFor(p);
    return p.label && !p.owner ? `${ph} (${p.label})` : ph;
  }

  private placeholderFor(p: Person): string {
    if (p.owner) {
      this.byPlaceholder.set("OWNER", this.byPlaceholder.get("OWNER") ?? p);
      return "OWNER";
    }
    if (!p.placeholder) {
      p.placeholder = `PERSON_${this.next++}`;
      this.byPlaceholder.set(p.placeholder, p);
    }
    return p.placeholder;
  }

  private build() {
    const fullMap = new Map<string, Person>();
    const alts: string[] = [];
    for (const p of this.people) {
      for (const s of p.spellings) {
        const variants = s.length === 2 ? [s, [s[1], s[0]]] : [s];
        for (const v of variants) {
          if (v.length < 2 && !p.owner) continue;
          const k = v.join("");
          if (fullMap.has(k)) continue;
          fullMap.set(k, p);
          alts.push(v.map((t) => t.replace(/[^A-Z]/g, "")).join("[\\s.'-]*"));
        }
      }
    }
    alts.sort((a, b) => b.length - a.length);
    // Single name words ("Ngozi" on its own). A word shared by two people gets its own placeholder.
    const owners = new Map<string, Person>();
    const counts = new Map<string, Person[]>();
    for (const p of this.people) {
      for (const t of new Set(p.spellings.flat())) {
        if (t.length < 3 || STOP_TOKENS.has(t)) continue;
        counts.set(t, [...(counts.get(t) ?? []), p]);
        if (p.owner) owners.set(t, p);
      }
    }
    const tokenMap = new Map<string, Person>();
    for (const [t, ps] of counts) {
      const unique = new Set(ps);
      if (unique.size === 1) tokenMap.set(t, ps[0]);
      else if ([...unique].every((p) => p.owner)) tokenMap.set(t, owners.get(t)!);
      else tokenMap.set(t, { display: titleCase(t), owner: false, spellings: [[t]] });
    }
    const tokens = [...tokenMap.keys()].sort((a, b) => b.length - a.length);
    this.matcher = {
      full: new RegExp(`(?<![A-Za-z])(?:${alts.join("|") || "(?!)"})(?![A-Za-z])`, "gi"),
      fullMap,
      token: tokens.length ? new RegExp(`(?<![A-Za-z_])(?:${tokens.join("|")})(?![A-Za-z_])`, "gi") : undefined,
      tokenMap,
    };
    return this.matcher;
  }

  /** Identifiers masked and names replaced by placeholders. Amounts are left as they are. */
  text(s: string): string {
    const m = this.matcher ?? this.build();
    let out = s;
    if (this.accounts.size) {
      const alts = [...this.accounts.values()].map((a) => a.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      out = out.replace(new RegExp(`(?<![A-Za-z0-9])(?:${alts.join("|")})(?![A-Za-z0-9])`, "gi"), (hit) => {
        const a = this.accounts.get(hit.toUpperCase())!;
        if (!a.placeholder) {
          a.placeholder = `ACCOUNT_${this.nextAccount++}`;
          this.accountsByPlaceholder.set(a.placeholder, a.label);
        }
        return a.placeholder;
      });
    }
    out = maskIdentifiers(out);
    out = out.replace(m.full, (hit) => {
      const p = m.fullMap.get(hit.toUpperCase().replace(/[^A-Z]/g, ""));
      return p ? this.tagged(p) : hit;
    });
    if (m.token) {
      out = out.replace(m.token, (hit) => {
        const p = m.tokenMap.get(hit.toUpperCase());
        return p ? this.tagged(p) : hit;
      });
      // A reordered name replaced word by word ("OKEKE AMAKA CHINWE") is one person, not three.
      out = out.replace(/\b(OWNER|PERSON_\d+(?: \([a-z &-]+\))?)(?:[\s.'-]+\1(?![\w(]))+/g, "$1");
    }
    return out;
  }

  /** text(), plus amounts rounded to three significant figures. For chat and insights. */
  textRounded(s: string): string {
    return roundMoneyInText(this.text(s));
  }

  /** Deep copy with every string passed through textRounded (or text, when amounts are kept). */
  value<T>(v: T, amounts: "round" | "keep" = "round"): T {
    const walk = (x: unknown): unknown => {
      if (typeof x === "string") return amounts === "round" ? this.textRounded(x) : this.text(x);
      if (typeof x === "bigint") return x.toString();
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
      return x;
    };
    return walk(v) as T;
  }

  /** Placeholders back to the names they stand for. Runs locally on the model's answer. */
  restore(s: string): string {
    return s
      .replace(/\bACCOUNT_\d+\b/g, (ph) => this.accountsByPlaceholder.get(ph) ?? ph)
      .replace(/\b(OWNER|PERSON_\d+)\b(?: \(([a-z &-]+)\))?/g, (hit, ph: string, label?: string) => {
        const p = this.byPlaceholder.get(ph);
        if (!p) return hit;
        return label && label !== p.label ? `${p.display} (${label})` : p.display;
      });
  }

  /** restore() on every string in a value (tool inputs the model sends back). */
  restoreValue<T>(v: T): T {
    const walk = (x: unknown): unknown => {
      if (typeof x === "string") return this.restore(x);
      if (Array.isArray(x)) return x.map(walk);
      if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
      return x;
    };
    return walk(v) as T;
  }

  /** The placeholder map, for tests and audit. Never sent anywhere. */
  placeholders(): Record<string, string> {
    return { ...Object.fromEntries([...this.byPlaceholder.entries()].map(([k, p]) => [k, p.display])), ...Object.fromEntries(this.accountsByPlaceholder) };
  }
}

/** A Redactor that knows the owner's names and every payee and sender in their ledger. */
export async function redactorFor(userId: string): Promise<Redactor> {
  const [user, accounts, txs, aliases, people] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { name: true } }),
    db.account.findMany({ where: { userId }, select: { holderName: true, accountName: true } }),
    db.transaction.findMany({ where: { userId }, select: { counterparty: true, merchantName: true }, distinct: ["counterparty", "merchantName"] }),
    db.merchantAlias.findMany({ where: { userId }, select: { canonicalName: true } }),
    db.person.findMany({ where: { userId }, select: { displayName: true, relationship: true, aliases: { where: { rejected: false }, select: { name: true } } } }),
  ]);
  const owners = [user?.name, ...accounts.map((a) => a.holderName)].filter((x): x is string => !!x);
  const names = [...txs.flatMap((t) => [t.counterparty, t.merchantName]), ...aliases.map((a) => a.canonicalName)].filter((x): x is string => !!x);
  const labels = accounts.map((a) => a.accountName).filter((x): x is string => !!x);
  // "Me" is the owner under another name: redacted as OWNER, never labelled.
  const known = people.filter((p) => p.relationship !== "me").map((p) => ({ names: [p.displayName, ...p.aliases.map((a) => a.name)], relationship: relationshipInfo(p.relationship).short }));
  const mine = people.filter((p) => p.relationship === "me").flatMap((p) => [p.displayName, ...p.aliases.map((a) => a.name)]);
  return new Redactor({ owners: [...owners, ...mine], known, people: [...new Set(names)], accounts: labels });
}
