import { db } from "@/lib/db";
import { formatMixedTotal, formatMoney, type CurrencyAmount } from "@/lib/money";
import { nairaAt } from "./analytics";
import { ALL_CATEGORIES, INCOME_CATEGORY, OWN_TRANSFER, categorize, isSelf, nameHint, nameTokens, sameName } from "./categorize";
import { loadFxContext, type FxContext } from "./fx/rates";
import { looksLikePerson } from "./ai/redact";
import { loadKnownPeople } from "./ledger";
import { createPerson, updatePerson } from "./people";
import { familySurnames, guessFor, type PeopleGuess } from "./people-guess";
import { RELATIONSHIPS, labelFor, mappingFor, matchPeople, relationshipInfo, sameIndividual, type KnownPerson } from "./people-match";
import { listPendingDuplicates, resolveDuplicate } from "./fx/duplicates";
import { listPendingAdvances, resolveAdvance } from "./fx/advance-flags";
import { rebuildUserFx, listPendingMispairs, resolveMispair } from "./fx/realised";
import { listPendingWalletGuesses, resolveWalletGuess } from "./fx/wallet-currency";
import { pairOwnTransfers, suspectedConversions, unpairContradicted } from "./transfers";
void suspectedConversions; // kept for answering legacy conversion questions

// "Teach Ledger": a short list of questions whose answers fix the most money at once.
// Every answer becomes a user rule, so it applies to past AND future transactions with that name.
// People come first: "Who is GIFT ADEBAYO OJO to you?" is answered once and labels every payment
// to and from them through the relationship (core/people).

export type QuestionKind = "holder" | "person" | "income" | "memo" | "conversion" | "match" | "mispair" | "duplicate" | "currency" | "advance";
export const QUESTION_KINDS: readonly QuestionKind[] = ["holder", "person", "income", "memo", "conversion", "match", "mispair", "duplicate", "currency", "advance"];

export interface Option {
  value: string;
  label: string;
  category: string;
  subcategory?: string;
  /**
   * How the answer is shown: "relationship" answers are the main one-tap buttons for a person,
   * "more" sit behind "Someone else", "control" are Skip / Not a person. Unset for other questions.
   */
  group?: "relationship" | "more" | "control";
}

/** Money in and out with one individual, for "Who is <NAME> to you?". */
export interface PersonStats {
  inCount: number;
  inMinor: bigint;
  outCount: number;
  outMinor: bigint;
  /** YYYY-MM-DD, Lagos time. */
  lastDate: string;
  /** Every spelling the bank used, saved as the person's aliases when the owner answers. */
  variants: string[];
  /** Original amounts by currency. Totals above are NGN-converted when more than one currency is present. */
  currencies?: { currency: string; inMinor: bigint; outMinor: bigint }[];
}

export interface Question {
  kind: QuestionKind;
  key: string; // what the answer is stored against (a name or a memo phrase)
  title: string;
  prompt: string;
  totalMinor: bigint;
  count: number;
  examples: string[];
  options: Option[];
  currentCategory?: string;
  /** What the name suggests they do ("Tailor or clothing"), or that it looks like a person. */
  hint?: string;
  /** Purpose words the user typed before the recipient ("WARDROBE TO ACCESS - …"), with the category they suggest. */
  narrationHints?: NarrationHint[];
  /** For conversion questions: the matching sends and receipts. */
  evidence?: { date: string; sent: string; received: string }[];
  /** For questions about an individual: money both ways and the spellings seen. */
  person?: PersonStats;
  /** Money still labelled as a plain transfer (or unlabelled) that the answer would fix. Sorts people questions. */
  impactMinor?: bigint;
  /** Ledger's own guess about who an unknown individual is, with one-tap answers. Changes nothing until tapped. */
  guess?: PeopleGuess;
  /** Currency of totalMinor when every row is the same; NGN when mixed or converted. */
  totalCurrency?: string;
  currencies?: CurrencyAmount[];
  /** Original currencies when the headline is an NGN-converted mixed total. */
  totalDetail?: string;
}

export interface NarrationHint {
  words: string;
  category: string;
  subcategory: string;
}

/** Up to this many full narrations are shown per question, so the user can check before answering. */
const MAX_EXAMPLES = 4;

const GENERIC_MEMO = new Set([
  "payment", "payments", "transfer", "trf", "nip", "mobile", "mob", "app", "ussd", "web", "pos", "instant", "outward", "inward", "opay", "palmpay",
  "moniepoint", "kuda", "money", "fund", "funds", "naira", "ngn", "send", "sent", "being", "for", "the", "and", "via", "ref", "utu", "frm", "from",
]);

/** The purpose typed before the recipient: "Instant Payment Outward 0001 WARDROBE TO ACCESS - JOHN DOE" -> "wardrobe". */
export function purposeWords(description: string): string | undefined {
  const memo = memoOf(description);
  if (!memo) return undefined;
  const words = memo.split(" ").filter((w) => !GENERIC_MEMO.has(w));
  return words.join("").length >= 3 ? words.join(" ") : undefined;
}

/** Distinct purpose words across a payee's narrations, most common first, each with the category it suggests. */
export function narrationHints(descriptions: string[], limit = 3): NarrationHint[] {
  const counts = new Map<string, number>();
  for (const d of descriptions) {
    const w = purposeWords(d);
    if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([words]) => ({ words, ...inferFromText("person", words) }));
}

/** Full narrations, distinct, as the bank wrote them. Never clipped: purpose words can sit anywhere in the line. */
function addExample(examples: string[], description: string) {
  const full = description.replace(/\s+/g, " ").trim();
  if (examples.length < MAX_EXAMPLES && !examples.includes(full)) examples.push(full);
}

export const PERSON_OPTIONS: Option[] = [
  { value: "family", label: "Family", category: "Family", subcategory: "Family support" },
  { value: "partner", label: "Partner or spouse", category: "Family", subcategory: "Spouse" },
  { value: "friend", label: "Friend", category: "Transfers", subcategory: "Friends" },
  { value: "landlord", label: "Landlord or rent", category: "Housing", subcategory: "Rent" },
  { value: "staff", label: "Someone I employ (driver, cleaner, nanny)", category: "Housing", subcategory: "Home services" },
  { value: "csr", label: "CSR (black tax)", category: "Family", subcategory: "Black tax" },
  { value: "vendor", label: "A business or vendor I buy from", category: "Shopping", subcategory: "Vendors" },
  { value: "work", label: "Work or business expense", category: "Business", subcategory: "Business expense" },
  { value: "loan", label: "Loan (given or repaid)", category: "Debt", subcategory: "Loans" },
  { value: "savings", label: "Savings or investment", category: OWN_TRANSFER, subcategory: "Savings" },
  { value: "me", label: "Me (another account of mine)", category: OWN_TRANSFER, subcategory: "Between own accounts" },
];

export const INCOME_OPTIONS: Option[] = [
  { value: "salary", label: "My salary", category: INCOME_CATEGORY, subcategory: "Salary" },
  { value: "freelance", label: "Freelance or consulting", category: INCOME_CATEGORY, subcategory: "Consulting" },
  { value: "business", label: "My business income", category: INCOME_CATEGORY, subcategory: "Business income" },
  { value: "refund", label: "Refund or reimbursement", category: INCOME_CATEGORY, subcategory: "Refund" },
  { value: "gift", label: "Gift or support", category: INCOME_CATEGORY, subcategory: "Gifts received" },
  { value: "me", label: "Me (from another account of mine)", category: OWN_TRANSFER, subcategory: "Between own accounts" },
];

export const CONVERSION_OPTIONS: Option[] = [
  { value: "yes", label: "Yes, it's my own money moved between my accounts", category: OWN_TRANSFER, subcategory: "Currency conversion" },
  { value: "no", label: "No, it's real income", category: INCOME_CATEGORY },
];

export const MISPAIR_OPTIONS: Option[] = [
  { value: "unpair", label: "Unpair — this looks like a mismatch", category: "" },
  { value: "keep", label: "Keep — this was a real conversion", category: OWN_TRANSFER, subcategory: "Currency conversion" },
];

export const DUPLICATE_OPTIONS: Option[] = [
  { value: "keep", label: "Keep both — they are different payments", category: "" },
  { value: "dismiss", label: "Got it — I'll review them myself", category: "" },
];

export const CURRENCY_OPTIONS: Option[] = [
  { value: "cad", label: "Yes, this wallet is CAD", category: "" },
  { value: "keep", label: "No, leave it as it is", category: "" },
];

export const ADVANCE_OPTIONS: Option[] = [
  { value: "hold", label: "Leave uncounted until a matching repayment lands", category: OWN_TRANSFER, subcategory: "Unpaired advance" },
  { value: "debt", label: "This is a real loan — count it as debt", category: "Debt", subcategory: "Loan proceeds" },
];

const HOLDER_OPTIONS: Option[] = [
  { value: "yes", label: "Yes, that's me", category: OWN_TRANSFER, subcategory: "Between own accounts" },
  { value: "no", label: "No", category: "" },
];

export function optionsFor(kind: QuestionKind): Option[] {
  return kind === "income" ? INCOME_OPTIONS
    : kind === "holder" ? HOLDER_OPTIONS
    : kind === "conversion" ? CONVERSION_OPTIONS
    : kind === "mispair" ? MISPAIR_OPTIONS
    : kind === "duplicate" ? DUPLICATE_OPTIONS
    : kind === "currency" ? CURRENCY_OPTIONS
    : kind === "advance" ? ADVANCE_OPTIONS
    : PERSON_OPTIONS;
}

/** The one-tap answers to "Who is <NAME> to you?". Each one creates a person (core/people). */
export const RELATIONSHIP_OPTIONS: Option[] = RELATIONSHIPS.map((r) => {
  const label = mappingFor(r.value, "DEBIT");
  return { value: `rel:${r.value}`, label: r.label, category: label?.category ?? "", ...(label?.subcategory && { subcategory: label.subcategory }), group: "relationship" as const };
});

const CONTROL_OPTIONS: Option[] = [
  { value: "unknown", label: "Skip", category: "", group: "control" },
  { value: "not_person", label: "Not a person", category: "", group: "control" },
];

/** Options for a question about an individual: relationships first, then the older detailed answers. */
const INDIVIDUAL_OPTIONS: Option[] = [...RELATIONSHIP_OPTIONS, ...PERSON_OPTIONS.map((o) => ({ ...o, group: "more" as const })), ...CONTROL_OPTIONS];

/** Marker on rules created by "Can't remember". */
export const SKIPPED = "__skipped__";
/** Marker on rules created by "Not a person": the name is never asked about as a person again. */
export const NOT_PERSON = "__not_person__";

/** Forget a skipped question so it can be asked again. Only removes rules that carry no category. */
export async function askAgain(userId: string, pattern: string): Promise<void> {
  await db.merchantAlias.deleteMany({ where: { userId, pattern, category: null } });
}

export const QUESTION_MIN_MINOR = 2_000_000n; // ₦20,000: compared to NGN-converted totals

/** "Instant Payment Outward 0901... MONTHLY TO" -> "monthly". The words the user typed before TO. */
export function memoOf(description: string): string | undefined {
  const d = description
    .replace(/instant payment outward|transfer between customers|outward transfer|nip transfer|airtime purchase/gi, " ")
    .replace(/\b\S*\d\S*\b/g, " ")
    .replace(/\bFROM\b.*?(?=\bTO\b|$)/i, " ");
  const m = d.match(/^(.*?)\bTO\b/i);
  const memo = (m ? m[1] : "").replace(/[^A-Za-z ]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return memo.length >= 3 && memo.split(" ").length <= 4 ? memo : undefined;
}

interface Group {
  key: string;
  display: string;
  total: bigint;
  count: number;
  examples: string[];
  descriptions: string[];
  categories: Map<string, number>;
  hits?: { minor: bigint; date: Date }[];
  byCurrency: Map<string, bigint>;
}

/** Same payee in 2+ months with amounts within 25% of the median: a regular commitment. */
export function regularPattern(hits: { minor: bigint; date: Date }[]): { typicalMinor: bigint; day: number; months: number } | undefined {
  if (hits.length < 2) return undefined;
  const lagos = (d: Date) => new Date(d.getTime() + 3600_000);
  const months = new Set(hits.map((h) => lagos(h.date).toISOString().slice(0, 7)));
  if (months.size < 2) return undefined;
  const sorted = [...hits].sort((a, b) => (a.minor < b.minor ? -1 : 1));
  const median = sorted[Math.floor(sorted.length / 2)].minor;
  const close = hits.filter((h) => (h.minor > median ? h.minor - median : median - h.minor) * 4n <= median);
  if (new Set(close.map((h) => lagos(h.date).toISOString().slice(0, 7))).size < 2) return undefined;
  const days = close.map((h) => lagos(h.date).getUTCDate()).sort((a, b) => a - b);
  return { typicalMinor: median, day: days[Math.floor(days.length / 2)], months: months.size };
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** Groups rows by person, treating names with the same words (any order, one a subset of the other) as one person. */
function addCurrency(g: Group, currency: string, minor: bigint) {
  g.byCurrency.set(currency, (g.byCurrency.get(currency) ?? 0n) + minor);
}

function groupMoney(g: Group): { display: string; detail: string | null; currency: string } {
  return formatMixedTotal([...g.byCurrency.entries()].map(([currency, minor]) => ({ currency, minor })), g.total);
}

function toNgn(ctx: FxContext, minor: bigint, currency: string, date: Date): bigint {
  return nairaAt(ctx, minor, currency, date)?.naira ?? (currency === "NGN" ? minor : 0n);
}

function groupByName(
  rows: { counterparty: string | null; amountMinor: bigint; currency?: string; description: string; category: string; transactionDate?: Date }[],
  ctx: FxContext,
): Group[] {
  const groups: Group[] = [];
  for (const r of rows) {
    if (!r.counterparty || nameTokens(r.counterparty).length < 2) continue;
    let g = groups.find((x) => sameName(x.display, r.counterparty!));
    if (!g) groups.push((g = { key: r.counterparty, display: r.counterparty, total: 0n, count: 0, examples: [], descriptions: [], categories: new Map(), byCurrency: new Map() }));
    if (r.counterparty.length > g.display.length) g.display = r.counterparty;
    const currency = r.currency ?? "NGN";
    g.total += toNgn(ctx, r.amountMinor, currency, r.transactionDate ?? new Date());
    addCurrency(g, currency, r.amountMinor);
    g.count++;
    if (r.transactionDate) (g.hits ??= []).push({ minor: toNgn(ctx, r.amountMinor, currency, r.transactionDate), date: r.transactionDate });
    addExample(g.examples, r.description);
    g.descriptions.push(r.description);
    g.categories.set(r.category, (g.categories.get(r.category) ?? 0) + 1);
  }
  for (const g of groups) g.key = g.display.toLowerCase();
  return groups.sort((a, b) => (b.total > a.total ? 1 : -1));
}

const topCategory = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

/** Rows a person question would relabel: plain transfers, unlabelled or guessed. */
function unlabelled(t: { category: string; subcategory: string | null; classificationSource: string }): boolean {
  return t.category === "Transfers" || t.category === "Other" || t.classificationSource === "default" || (t.category === INCOME_CATEGORY && (!t.subcategory || t.subcategory === "Transfer"));
}

const lagosDay = (d: Date) => new Date(d.getTime() + 3600_000).toISOString().slice(0, 10);

interface TxRow {
  type: string;
  counterparty: string | null;
  amountMinor: bigint;
  currency: string;
  description: string;
  category: string;
  subcategory: string | null;
  classificationSource: string;
  classificationConfidence: number;
  transactionDate: Date;
  personId: string | null;
}

interface PersonGroup extends Group {
  stats: PersonStats;
  impact: bigint;
  last: Date;
}

/** Individuals (not businesses, not the owner) the owner has not told Ledger about, money both ways. */
function bumpStatCurrency(s: PersonStats, currency: string, type: string, minor: bigint) {
  const list = s.currencies ?? (s.currencies = []);
  let row = list.find((x) => x.currency === currency);
  if (!row) { row = { currency, inMinor: 0n, outMinor: 0n }; list.push(row); }
  if (type === "CREDIT") row.inMinor += minor;
  else row.outMinor += minor;
}

function individuals(tx: TxRow[], owners: string[], people: KnownPerson[], ctx: FxContext): { unknown: PersonGroup[]; ambiguous: PersonGroup[] } {
  const unknown: PersonGroup[] = [], ambiguous: PersonGroup[] = [];
  for (const t of tx) {
    const name = t.counterparty;
    if (!name || t.personId || t.category === OWN_TRANSFER || !looksLikePerson(name) || isSelf(name, owners)) continue;
    const match = matchPeople(name, people);
    if (match.status === "match") continue;
    const list = match.status === "ambiguous" ? ambiguous : unknown;
    let g = list.find((x) => x.stats.variants.some((v) => v === name || sameName(v, name) || sameIndividual(v, name)));
    if (!g) {
      g = { key: name, display: name, total: 0n, count: 0, examples: [], descriptions: [], categories: new Map(), byCurrency: new Map(), impact: 0n, last: t.transactionDate,
        stats: { inCount: 0, inMinor: 0n, outCount: 0, outMinor: 0n, lastDate: "", variants: [] } };
      list.push(g);
    }
    if (!g.stats.variants.includes(name)) g.stats.variants.push(name);
    if (name.length > g.display.length) g.display = name;
    const ngn = toNgn(ctx, t.amountMinor, t.currency, t.transactionDate);
    g.total += ngn;
    addCurrency(g, t.currency, t.amountMinor);
    g.count++;
    if (t.type === "CREDIT") {
      g.stats.inCount++;
      g.stats.inMinor += ngn;
    } else {
      g.stats.outCount++;
      g.stats.outMinor += ngn;
      (g.hits ??= []).push({ minor: ngn, date: t.transactionDate });
    }
    bumpStatCurrency(g.stats, t.currency, t.type, t.amountMinor);
    if (unlabelled(t)) g.impact += ngn;
    if (t.transactionDate > g.last) g.last = t.transactionDate;
    addExample(g.examples, t.description);
    g.descriptions.push(t.description);
    g.categories.set(t.category, (g.categories.get(t.category) ?? 0) + 1);
  }
  for (const g of [...unknown, ...ambiguous]) {
    g.key = g.display.toLowerCase();
    g.stats.lastDate = lagosDay(g.last);
  }
  return { unknown, ambiguous };
}

function statMoney(minor: bigint, currencies: { currency: string; inMinor: bigint; outMinor: bigint }[] | undefined, side: "in" | "out"): string {
  const parts = (currencies ?? []).map((c) => ({ currency: c.currency, minor: side === "in" ? c.inMinor : c.outMinor })).filter((c) => c.minor !== 0n);
  return formatMixedTotal(parts, minor).display;
}

function moneyBoth(s: PersonStats): string {
  const parts = [
    s.outCount && `you sent ${s.outCount} payment${s.outCount > 1 ? "s" : ""} (${statMoney(s.outMinor, s.currencies, "out")})`,
    s.inCount && `they sent you ${s.inCount} (${statMoney(s.inMinor, s.currencies, "in")})`,
  ].filter(Boolean);
  return parts.join(" and ").replace(/^./, (c) => c.toUpperCase());
}

/** Unknown individuals asked about at a time. The rest wait their turn; their payments stay where the rules put them. */
export const MAX_PEOPLE_QUESTIONS = 5;

const personRank = (g: PersonGroup) => g.impact * 4n + g.total;

function questionMoney(g: Group): Pick<Question, "totalMinor" | "totalCurrency" | "currencies" | "totalDetail"> {
  const money = groupMoney(g);
  return {
    totalMinor: g.total,
    totalCurrency: money.currency,
    currencies: [...g.byCurrency.entries()].map(([currency, minor]) => ({ currency, minor })),
    ...(money.detail && { totalDetail: money.detail }),
  };
}

async function reviewData(userId: string) {
  const [aliases, accounts, tx, people, user, ctx] = await Promise.all([
    db.merchantAlias.findMany({ where: { userId }, select: { pattern: true } }),
    db.account.findMany({ where: { userId }, select: { holderName: true } }),
    db.transaction.findMany({
      where: { userId, classificationSource: { not: "user" } },
      select: {
        type: true, counterparty: true, amountMinor: true, currency: true, description: true, category: true, subcategory: true, classificationSource: true,
        classificationConfidence: true, transactionDate: true, personId: true,
      },
    }),
    loadKnownPeople(userId),
    db.user.findUnique({ where: { id: userId }, select: { name: true } }),
    loadFxContext(userId),
  ]);
  const answered = (key: string) => aliases.some((a) => a.pattern === key || sameName(a.pattern, key));
  const owners = accounts.map((a) => a.holderName).filter((h): h is string => !!h);
  return { answered, accounts, tx, people, owners, found: individuals(tx, owners, people, ctx), surnames: familySurnames(user?.name, owners, people), ctx };
}

export interface TopPerson {
  key: string;
  display: string;
  person: PersonStats;
  guess?: PeopleGuess;
}

/** "You send money to these people most": unknown individuals by money sent, for one-tap answers after the first upload. */
export async function topUnknownPeople(userId: string, limit = 6): Promise<TopPerson[]> {
  const { answered, found, surnames } = await reviewData(userId);
  return found.unknown
    .filter((g) => g.stats.outCount > 0 && !answered(g.key))
    .sort((a, b) => (b.stats.outMinor > a.stats.outMinor ? 1 : b.stats.outMinor < a.stats.outMinor ? -1 : 0))
    .slice(0, limit)
    .map((g) => ({ key: g.key, display: g.display, person: g.stats, guess: guessOf(g, surnames) }));
}

function guessOf(g: PersonGroup, surnames: string[]): PeopleGuess | undefined {
  return guessFor({ name: g.display, inCount: g.stats.inCount, outCount: g.stats.outCount, regular: regularPattern(g.hits ?? []), surnames });
}

export async function buildQuestions(userId: string, limit = 12): Promise<Question[]> {
  const { answered, accounts, tx, people, found, surnames, ctx } = await reviewData(userId);
  const questions: Question[] = [];

  for (const a of await listPendingAdvances(userId)) {
    questions.push({
      kind: "advance",
      key: a.key,
      title: "Unmatched Deel salary advance",
      prompt: `${a.amount} on ${a.date} looks like a Deel salary advance without a matching repayment (or the other way around). It is not counted as income or spending until it pairs, or you say it is a real loan.`,
      totalMinor: a.totalMinor,
      count: 1,
      examples: a.examples,
      options: ADVANCE_OPTIONS,
    });
  }

  for (const g of await listPendingWalletGuesses(userId)) {
    questions.push({
      kind: "currency",
      key: g.key,
      title: "This wallet looks like CAD, confirm?",
      prompt: `${g.label} is stored as ${g.current}, but the wallet id, CAD funding lines, or landing rates (~0.75× USD) look like Canadian dollars. Confirming relabels the account and rebuilds rates. Nothing is changed until you answer.`,
      totalMinor: g.totalMinor,
      totalCurrency: g.current,
      count: Math.max(1, g.examples.length),
      examples: g.examples,
      options: CURRENCY_OPTIONS,
    });
  }

  for (const d of await listPendingDuplicates(userId)) {
    const extra = d.debitIds.length ? " Matching foreign debits of the same size may also be duplicated." : "";
    questions.push({
      kind: "duplicate",
      key: d.key,
      title: "Possible duplicate bank credit",
      prompt: `Two ${d.amount} credits on ${d.date} (or the next day) use different narration formats, but the running balance only moved once.${extra} Ledger will not delete either row — mark them so they stop appearing here.`,
      totalMinor: d.totalMinor,
      totalCurrency: "NGN",
      count: d.creditIds.length + d.debitIds.length,
      examples: d.examples,
      options: DUPLICATE_OPTIONS,
    });
  }

  for (const m of await listPendingMispairs(userId)) {
    const per = m.impliedRate > 0 ? `implied about ₦${m.impliedRate.toLocaleString("en-NG", { maximumFractionDigits: 0 })} per unit` : "the implied rate";
    questions.push({
      kind: "mispair",
      key: m.key,
      title: "Likely mismatched currency conversion",
      prompt: `A linked pair on ${m.date} sent ${m.sent} and received ${m.received} (${per}). That is more than 10% from the market rate (or 15% from the typical rate) for that currency, so it was not used as a rate and the pair was unpaired.`,
      totalMinor: m.totalMinor,
      totalCurrency: "NGN",
      count: 2,
      examples: m.examples,
      options: MISPAIR_OPTIONS,
      evidence: [{ date: m.date, sent: m.sent, received: m.received }],
    });
  }

  // People first: one answer labels every payment to and from them. Only the few that move the most
  // money are asked at once; every unknown individual is kept out of the business questions below.
  const asked = new Set<string>();
  found.unknown.forEach((g) => g.stats.variants.forEach((v) => asked.add(v)));
  const worthAsking = found.unknown
    .filter((g) => (g.total >= QUESTION_MIN_MINOR || g.count >= 3) && !answered(g.key))
    .sort((a, b) => (personRank(b) > personRank(a) ? 1 : personRank(b) < personRank(a) ? -1 : 0))
    .slice(0, MAX_PEOPLE_QUESTIONS);
  for (const g of worthAsking) {
    const regular = regularPattern(g.hits ?? []);
    const guess = guessOf(g, surnames);
    questions.push({
      kind: "person", key: g.key, title: `Who is ${g.display} to you?`,
      prompt: regular
        ? `You pay them about ${formatMoney(regular.typicalMinor)} around the ${ordinal(regular.day)} of the month (${regular.months} months so far). Regular payments are usually family support, rent, an allowance, or someone you employ.`
        : `${moneyBoth(g.stats)}. Your answer applies to every payment with them, past and future, and you can undo it.`,
      ...questionMoney(g), count: g.count, examples: g.examples.slice(0, 3), options: INDIVIDUAL_OPTIONS, currentCategory: topCategory(g.categories),
      hint: "The name looks like a person", narrationHints: narrationHints(g.descriptions), person: g.stats, impactMinor: g.impact,
      ...(guess && { guess }),
    });
  }
  for (const g of found.ambiguous.filter((g) => !answered(g.key))) {
    const candidates = matchPeople(g.display, people).candidates.map((c) => people.find((p) => p.id === c.personId)!).slice(0, 3);
    g.stats.variants.forEach((v) => asked.add(v));
    questions.push({
      kind: "match", key: g.key,
      title: candidates.length === 1 ? `Is ${g.display} ${candidates[0].displayName}?` : `Which of your people is ${g.display}?`,
      prompt: `The name is close to ${candidates.map((p) => `${p.displayName} (${relationshipInfo(p.relationship).short})`).join(" and ")}, but not close enough to be sure. ${moneyBoth(g.stats)}.`,
      ...questionMoney(g), count: g.count, examples: g.examples.slice(0, 3),
      options: [
        ...candidates.map((p) => ({ value: `person:${p.id}`, label: `Yes, ${p.displayName}`, category: labelFor(p, "DEBIT")?.category ?? "", group: "relationship" as const })),
        { value: "no", label: candidates.length === 1 ? "No, someone else" : "None of them", category: "", group: "relationship" },
        { value: "unknown", label: "Skip", category: "", group: "control" },
      ],
      currentCategory: topCategory(g.categories), person: g.stats, impactMinor: g.impact,
    });
  }
  const individual = (name: string | null) => !!name && asked.has(name);

  // 1. Confirm who the account holder is (drives own-transfer detection).
  const holder = accounts.find((a) => a.holderName)?.holderName;
  if (holder && !answered(holder.toLowerCase())) {
    questions.push({
      kind: "holder", key: holder.toLowerCase(), title: `Are you ${holder}?`,
      prompt: "We use this to spot money moving between your own accounts, so it isn't counted as income or spending.",
      totalMinor: 0n, count: 0, examples: [], options: HOLDER_OPTIONS,
    });
  }

  // 2. Where income comes from (biggest first).
  const credits = groupByName(tx.filter((t) => t.type === "CREDIT" && t.category !== OWN_TRANSFER && t.category !== "Debt" && !individual(t.counterparty) && !t.personId), ctx);
  for (const g of credits.filter((g) => g.total >= QUESTION_MIN_MINOR && !answered(g.key)).slice(0, 4)) {
    questions.push({
      kind: "income", key: g.key, title: `What is the money from ${g.display}?`,
      prompt: `${g.count} payment${g.count > 1 ? "s" : ""} in. Tell us once and we'll label every payment from them.`,
      ...questionMoney(g), count: g.count, examples: g.examples, options: INCOME_OPTIONS, currentCategory: topCategory(g.categories),
    });
  }

  // 3. People and businesses you pay (biggest first), skipping ones already confidently categorized by a merchant rule.
  // Skip payments a specific rule already labelled with high confidence (e.g. "RENT", Squad, Netflix).
  const debits = groupByName(tx.filter((t) => t.type === "DEBIT" && t.category !== OWN_TRANSFER && t.category !== "Fees" && t.classificationConfidence < 0.9 && !individual(t.counterparty) && !t.personId), ctx);
  for (const g of debits.filter((g) => g.total >= QUESTION_MIN_MINOR && !answered(g.key)).slice(0, 8)) {
    const hint = nameHint(g.display);
    const options = hint ? [{ value: "hint", label: `${hint.label} (suggested)`, category: hint.category, subcategory: hint.subcategory }, ...PERSON_OPTIONS] : PERSON_OPTIONS;
    const regular = regularPattern(g.hits ?? []);
    questions.push({
      kind: "person", key: g.key, title: hint ? `Is ${g.display} ${/^[aeiou]/i.test(hint.label) ? "an" : "a"} ${hint.label.toLowerCase()}?` : `Who is ${g.display}?`,
      prompt: regular
        ? `You pay them about ${formatMoney(regular.typicalMinor)} around the ${ordinal(regular.day)} of the month (${regular.months} months so far). Regular payments are usually rent, an allowance, or someone you employ.`
        : `You sent them ${g.count} payment${g.count > 1 ? "s" : ""}. Your answer applies to every payment to this name, past and future.`,
      ...questionMoney(g), count: g.count, examples: g.examples, options, currentCategory: topCategory(g.categories),
      hint: hint ? `The name suggests: ${hint.label.toLowerCase()}` : "The name looks like a person",
      narrationHints: narrationHints(g.descriptions),
    });
  }

  // 4. Transfers with no name but a repeated memo ("MONTHLY TO"): ask about the memo.
  const memos = new Map<string, Group>();
  for (const t of tx.filter((t) => t.type === "DEBIT" && !t.counterparty && t.category === "Transfers")) {
    const memo = memoOf(t.description);
    if (!memo || answered(memo)) continue;
    const g: Group = memos.get(memo) ?? { key: memo, display: memo, total: 0n, count: 0, examples: [], descriptions: [], categories: new Map(), byCurrency: new Map() };
    const ngn = toNgn(ctx, t.amountMinor, t.currency, t.transactionDate);
    g.total += ngn;
    addCurrency(g, t.currency, t.amountMinor);
    g.count++;
    (g.hits ??= []).push({ minor: ngn, date: t.transactionDate });
    addExample(g.examples, t.description);
    memos.set(memo, g);
  }
  for (const g of [...memos.values()].filter((g) => g.total >= QUESTION_MIN_MINOR).sort((a, b) => (b.total > a.total ? 1 : -1)).slice(0, 3)) {
    questions.push({
      kind: "memo", key: g.key, title: `What are your "${g.display.toUpperCase()}" transfers?`,
      prompt: (() => {
        const regular = regularPattern(g.hits ?? []);
        const base = `${g.count} transfer${g.count > 1 ? "s" : ""} where your bank didn't record who received the money, only the note you typed.`;
        return regular ? `${base} It looks regular: about ${formatMoney(regular.typicalMinor)} around the ${ordinal(regular.day)} of each month.` : base;
      })(),
      ...questionMoney(g), count: g.count, examples: g.examples, options: PERSON_OPTIONS,
    });
  }

  // Regular payments first among equals: one answer covers every future month.
  const weight = (q: Question) => (/around the \d+(st|nd|rd|th)/.test(q.prompt) ? q.totalMinor * 2n : q.totalMinor);
  // People questions are ranked by the unlabelled money they fix, then by everything with them.
  const impact = (q: Question) => (q.impactMinor ?? 0n) * 4n + q.totalMinor;
  const rank = (q: Question) => (q.kind === "holder" ? 0 : q.kind === "currency" || q.kind === "mispair" || q.kind === "duplicate" || q.kind === "advance" ? 1 : q.person ? 2 : q.kind === "conversion" ? 3 : 4);
  questions.sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    const [x, y] = a.person && b.person ? [impact(a), impact(b)] : [weight(a), weight(b)];
    return y > x ? 1 : y < x ? -1 : 0;
  });
  // Holder first, then people by money impact, then the rest by money affected.
  return questions.slice(0, limit);
}

/** Spellings of a name across the owner's transactions, for saving as aliases. */
async function variantsOf(userId: string, key: string): Promise<string[]> {
  const rows = await db.transaction.findMany({ where: { userId, counterparty: { not: null } }, select: { counterparty: true }, distinct: ["counterparty"] });
  const out = rows.map((r) => r.counterparty!).filter((c) => c.toLowerCase() === key || sameName(c, key) || sameIndividual(c, key));
  return out.length ? out : [key.replace(/\b[a-z]/g, (c) => c.toUpperCase())];
}

/**
 * "Who is <NAME> to you?" answered with a relationship: saves the person with every spelling seen
 * and relabels their payments (undoable from Your people). Returns rows changed.
 */
async function answerWho(userId: string, key: string, relationship: string, vendor?: { category?: string; subcategory?: string }): Promise<number> {
  const variants = await variantsOf(userId, key);
  const display = [...variants].sort((a, b) => b.length - a.length)[0];
  const res = await createPerson(userId, {
    displayName: display, relationship, aliases: variants, vendorCategory: vendor?.category, vendorSubcategory: vendor?.subcategory,
  });
  return res.changed;
}

/** "Is OJO G A Gift Adebayo Ojo?": yes saves the spelling to them, no tells Ledger it is someone else. */
async function answerMatch(userId: string, key: string, value: string): Promise<number> {
  const variants = await variantsOf(userId, key);
  if (value.startsWith("person:")) return (await updatePerson(userId, value.slice(7), { addAliases: variants })).changed;
  const people = await loadKnownPeople(userId);
  const ids = new Set(variants.flatMap((v) => matchPeople(v, people).candidates.map((c) => c.personId)));
  for (const id of ids) await updatePerson(userId, id, { rejectAliases: variants });
  return 0;
}

/** Stores the answer as a rule and relabels every matching transaction now. Returns rows updated. */
// Relationship words people type in "Other" answers.
const RELATIONSHIP_WORDS: [RegExp, { category: string; subcategory?: string }][] = [
  [/\b(sister|brother|sibling|aunt|aunty|auntie|uncle|cousin|niece|nephew|son|daughter|child|kids?|in-?law|grand(ma|pa|mother|father)|mum|mom|mother|dad|father|parents?|family|wife|husband|spouse|fianc)/, { category: "Family" }],
  [/\b(friend|bestie|buddy|classmate|colleague)/, { category: "Transfers", subcategory: "Friends" }],
  [/\b(landlord|landlady|caretaker|agent|rent|house|apartment)/, { category: "Housing" }],
  [/\b(driver|cleaner|nanny|gardener|security|guard|cook|chef|maid|house ?help|steward|plumber|electrician)/, { category: "Housing", subcategory: "Home services" }],
  [/\b(employee|staff|contractor|freelancer|developer|designer|assistant|vendor for work|client)/, { category: "Business" }],
  [/\b(church|tithe|offering|mosque|charity|donation|pastor)/, { category: "Giving" }],
  [/\b(savings?|invest|piggyvest|cowrywise|stocks?|crypto)/, { category: OWN_TRANSFER, subcategory: "Savings" }],
  [/\b(funded my|fund(ed|ing)? (my )?wallet|top ?up my|my (\w+ )?wallet)/, { category: OWN_TRANSFER, subcategory: "Wallet top-up" }],
  [/\b(rest[au]{0,2}r[ae]?nt|resturant|resturent|restaurent|eatery|small chops|suya|canteen|buka|food|lunch|dinner)/, { category: "Food", subcategory: "Eating out" }],
  [/\b(super ?market|groceries|provisions|market)/, { category: "Food", subcategory: "Groceries" }],
  [/\b(my other account|myself|me\b|own account)/, { category: OWN_TRANSFER, subcategory: "Between own accounts" }],
  [/\b(loan|debt|borrow|lend)/, { category: "Debt", subcategory: "Loans" }],
];

const tidyLabel = (t: string) => t.replace(/\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 40);

/**
 * Turns a free-text "Other" answer ("my landlady", "J's tailor", "car loan") into a category.
 * An explicit category wins; otherwise relationship words, then the normal rules and name hints.
 * The user's own words are kept as the subcategory label.
 */
export function inferFromText(kind: QuestionKind, text: string, chosenCategory?: string): { category: string; subcategory: string } {
  const label = tidyLabel(text);
  if (chosenCategory && ALL_CATEGORIES.includes(chosenCategory)) return { category: chosenCategory, subcategory: label };
  const t = text.toLowerCase();
  const rel = RELATIONSHIP_WORDS.find(([re]) => re.test(t))?.[1];
  if (rel && !(kind === "income" && rel.category !== OWN_TRANSFER)) return { category: rel.category, subcategory: label };
  if (kind === "income") return { category: INCOME_CATEGORY, subcategory: label };
  const c = categorize({ description: text, type: "DEBIT" });
  if (c.source === "rule") return { category: c.category, subcategory: label };
  const hint = nameHint(text);
  if (hint) return { category: hint.category, subcategory: label };
  return { category: "Other", subcategory: label };
}

export async function answerQuestion(
  userId: string,
  kind: QuestionKind,
  key: string,
  value: string,
  other?: { text: string; category?: string; subcategory?: string },
): Promise<number> {
  if (value.startsWith("rel:")) {
    const vendor = other?.category && ALL_CATEGORIES.includes(other.category) ? { category: other.category, subcategory: other.subcategory?.trim() || other.text?.trim() || undefined } : undefined;
    return answerWho(userId, key, value.slice(4), vendor);
  }
  if (value === "not_person") {
    await db.merchantAlias.upsert({
      where: { userId_pattern: { userId, pattern: key } },
      update: { category: null, subcategory: NOT_PERSON },
      create: { userId, pattern: key, canonicalName: key.replace(/\b[a-z]/g, (c) => c.toUpperCase()), category: null, subcategory: NOT_PERSON },
    });
    return 0;
  }
  if (kind === "match" && value !== "unknown") return answerMatch(userId, key, value);

  if (kind === "mispair") {
    if (value !== "unpair" && value !== "keep") throw new Error("unknown answer");
    return resolveMispair(userId, key, value);
  }

  if (kind === "duplicate") {
    if (value !== "keep" && value !== "dismiss") throw new Error("unknown answer");
    return resolveDuplicate(userId, key, value);
  }

  if (kind === "currency") {
    if (value !== "cad" && value !== "keep") throw new Error("unknown answer");
    const n = await resolveWalletGuess(userId, key, value);
    if (value === "cad") await rebuildUserFx(userId);
    return n;
  }

  if (kind === "advance") {
    if (value !== "hold" && value !== "debt") throw new Error("unknown answer");
    return resolveAdvance(userId, key, value);
  }

  if (kind === "conversion") {
    // Remember the answer so the question isn't asked again.
    await db.merchantAlias.upsert({
      where: { userId_pattern: { userId, pattern: key } },
      update: { category: null, subcategory: value === "yes" ? "confirmed conversion" : value === "no" ? "not a conversion" : SKIPPED },
      create: { userId, pattern: key, canonicalName: key, category: null, subcategory: value === "yes" ? "confirmed conversion" : value === "no" ? "not a conversion" : SKIPPED },
    });
    if (value !== "yes") return 0;
    const name = key.replace(/^conversion:/, "");
    const evidence = (await suspectedConversions(userId)).find((c) => c.name.toLowerCase() === name);
    const ids = evidence?.rows.map((r) => r.creditId) ?? [];
    if (!ids.length) return 0;
    // Only the matched receipts change; other payments from the same name keep their label.
    const res = await db.transaction.updateMany({
      where: { userId, id: { in: ids } },
      data: { category: OWN_TRANSFER, subcategory: "Currency conversion", classificationSource: "user", classificationConfidence: 1 },
    });
    await pairOwnTransfers(userId);
    return res.count;
  }

  if (value === "unknown") {
    // "Can't remember": stop asking, change nothing. Stored as a rule with no category (rules without
    // a category never affect categorization) so it can be listed and re-asked from Settings.
    await db.merchantAlias.upsert({
      where: { userId_pattern: { userId, pattern: key } },
      update: { category: null, subcategory: SKIPPED },
      create: { userId, pattern: key, canonicalName: key.replace(/\b[a-z]/g, (c) => c.toUpperCase()), category: null, subcategory: SKIPPED },
    });
    return 0;
  }
  const hint = value === "hint" ? nameHint(key) : undefined;
  const typed = value === "other" && other?.text.trim() ? inferFromText(kind, other.text, other.category) : undefined;
  const option = typed
    ? { value, label: typed.subcategory, ...typed }
    : hint
      ? { value, ...hint }
      : optionsFor(kind).find((o) => o.value === value);
  if (!option) throw new Error("unknown answer");

  if (kind === "holder" && value === "no") {
    await db.account.updateMany({ where: { userId, holderName: { not: null } }, data: { holderName: null } });
    await db.merchantAlias.upsert({
      where: { userId_pattern: { userId, pattern: key } },
      update: { category: null, subcategory: null },
      create: { userId, pattern: key, canonicalName: key, category: null },
    });
    return 0;
  }

  const display = key.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  await db.merchantAlias.upsert({
    where: { userId_pattern: { userId, pattern: key } },
    update: { category: option.category, subcategory: option.subcategory ?? null, canonicalName: display },
    create: { userId, pattern: key, canonicalName: display, category: option.category, subcategory: option.subcategory ?? null },
  });

  const type = kind === "income" ? "CREDIT" : kind === "holder" ? undefined : "DEBIT";
  const rows = await db.transaction.findMany({
    where: { userId, ...(type && { type }), classificationSource: { not: "user" } },
    select: { id: true, counterparty: true, description: true },
  });
  const ids = rows
    .filter((r) => (kind === "memo" ? !r.counterparty && memoOf(r.description) === key : sameName(r.counterparty ?? "", key)))
    .map((r) => r.id);
  if (!ids.length) return 0;
  const res = await db.transaction.updateMany({
    where: { id: { in: ids } },
    data: { category: option.category, subcategory: option.subcategory ?? null, classificationSource: "user", classificationConfidence: 1 },
  });
  if (option.category === OWN_TRANSFER) await pairOwnTransfers(userId);
  else await unpairContradicted(userId, ids);
  return res.count;
}
