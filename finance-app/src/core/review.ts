import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { ALL_CATEGORIES, INCOME_CATEGORY, OWN_TRANSFER, categorize, nameHint, nameTokens, sameName } from "./categorize";
import { pairOwnTransfers, suspectedConversions, unpairContradicted } from "./transfers";
void suspectedConversions; // kept for answering legacy conversion questions

// "Teach Ledger": a short list of questions whose answers fix the most money at once.
// Every answer becomes a user rule, so it applies to past AND future transactions with that name.

export type QuestionKind = "holder" | "person" | "income" | "memo" | "conversion";
export const QUESTION_KINDS: readonly QuestionKind[] = ["holder", "person", "income", "memo", "conversion"];

export interface Option {
  value: string;
  label: string;
  category: string;
  subcategory?: string;
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
  { value: "partner", label: "Partner or spouse", category: "Family", subcategory: "Partner" },
  { value: "friend", label: "Friend", category: "Transfers", subcategory: "Friends" },
  { value: "landlord", label: "Landlord or rent", category: "Housing", subcategory: "Rent" },
  { value: "staff", label: "Someone I employ (driver, cleaner, nanny)", category: "Housing", subcategory: "Home services" },
  { value: "car", label: "Car (mechanic, parts, repairs, car purchase)", category: "Transport", subcategory: "Car" },
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

const HOLDER_OPTIONS: Option[] = [
  { value: "yes", label: "Yes, that's me", category: OWN_TRANSFER, subcategory: "Between own accounts" },
  { value: "no", label: "No", category: "" },
];

export function optionsFor(kind: QuestionKind): Option[] {
  return kind === "income" ? INCOME_OPTIONS : kind === "holder" ? HOLDER_OPTIONS : kind === "conversion" ? CONVERSION_OPTIONS : PERSON_OPTIONS;
}

/** Marker on rules created by "Can't remember". */
export const SKIPPED = "__skipped__";

/** Forget a skipped question so it can be asked again. Only removes rules that carry no category. */
export async function askAgain(userId: string, pattern: string): Promise<void> {
  await db.merchantAlias.deleteMany({ where: { userId, pattern, category: null } });
}

const QUESTION_MIN_MINOR = 2_000_000n; // ₦20,000: below this an answer moves too little money to be worth asking

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

interface Group { key: string; display: string; total: bigint; count: number; examples: string[]; descriptions: string[]; categories: Map<string, number>; hits?: { minor: bigint; date: Date }[] }

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
function groupByName(rows: { counterparty: string | null; amountMinor: bigint; description: string; category: string; transactionDate?: Date }[]): Group[] {
  const groups: Group[] = [];
  for (const r of rows) {
    if (!r.counterparty || nameTokens(r.counterparty).length < 2) continue;
    let g = groups.find((x) => sameName(x.display, r.counterparty!));
    if (!g) groups.push((g = { key: r.counterparty, display: r.counterparty, total: 0n, count: 0, examples: [], descriptions: [], categories: new Map() }));
    if (r.counterparty.length > g.display.length) g.display = r.counterparty;
    g.total += r.amountMinor;
    g.count++;
    if (r.transactionDate) (g.hits ??= []).push({ minor: r.amountMinor, date: r.transactionDate });
    addExample(g.examples, r.description);
    g.descriptions.push(r.description);
    g.categories.set(r.category, (g.categories.get(r.category) ?? 0) + 1);
  }
  for (const g of groups) g.key = g.display.toLowerCase();
  return groups.sort((a, b) => (b.total > a.total ? 1 : -1));
}

const topCategory = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

export async function buildQuestions(userId: string, limit = 12): Promise<Question[]> {
  const [aliases, accounts, tx] = await Promise.all([
    db.merchantAlias.findMany({ where: { userId }, select: { pattern: true } }),
    db.account.findMany({ where: { userId }, select: { holderName: true } }),
    db.transaction.findMany({
      where: { userId, classificationSource: { not: "user" } },
      select: { type: true, counterparty: true, amountMinor: true, description: true, category: true, classificationConfidence: true, transactionDate: true },
    }),
  ]);
  const answered = (key: string) => aliases.some((a) => a.pattern === key || sameName(a.pattern, key));
  const questions: Question[] = [];

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
  const credits = groupByName(tx.filter((t) => t.type === "CREDIT" && t.category !== OWN_TRANSFER && t.category !== "Debt"));
  for (const g of credits.filter((g) => g.total >= QUESTION_MIN_MINOR && !answered(g.key)).slice(0, 4)) {
    questions.push({
      kind: "income", key: g.key, title: `What is the money from ${g.display}?`,
      prompt: `${g.count} payment${g.count > 1 ? "s" : ""} in. Tell us once and we'll label every payment from them.`,
      totalMinor: g.total, count: g.count, examples: g.examples, options: INCOME_OPTIONS, currentCategory: topCategory(g.categories),
    });
  }

  // 3. People and businesses you pay (biggest first), skipping ones already confidently categorized by a merchant rule.
  // Skip payments a specific rule already labelled with high confidence (e.g. "RENT", Squad, Netflix).
  const debits = groupByName(tx.filter((t) => t.type === "DEBIT" && t.category !== OWN_TRANSFER && t.category !== "Fees" && t.classificationConfidence < 0.9));
  for (const g of debits.filter((g) => g.total >= QUESTION_MIN_MINOR && !answered(g.key)).slice(0, 8)) {
    const hint = nameHint(g.display);
    const options = hint ? [{ value: "hint", label: `${hint.label} (suggested)`, category: hint.category, subcategory: hint.subcategory }, ...PERSON_OPTIONS] : PERSON_OPTIONS;
    const regular = regularPattern(g.hits ?? []);
    questions.push({
      kind: "person", key: g.key, title: hint ? `Is ${g.display} ${/^[aeiou]/i.test(hint.label) ? "an" : "a"} ${hint.label.toLowerCase()}?` : `Who is ${g.display}?`,
      prompt: regular
        ? `You pay them about ${formatMoney(regular.typicalMinor)} around the ${ordinal(regular.day)} of the month (${regular.months} months so far). Regular payments are usually rent, an allowance, or someone you employ.`
        : `You sent them ${g.count} payment${g.count > 1 ? "s" : ""}. Your answer applies to every payment to this name, past and future.`,
      totalMinor: g.total, count: g.count, examples: g.examples, options, currentCategory: topCategory(g.categories),
      hint: hint ? `The name suggests: ${hint.label.toLowerCase()}` : "The name looks like a person",
      narrationHints: narrationHints(g.descriptions),
    });
  }

  // 4. Transfers with no name but a repeated memo ("MONTHLY TO"): ask about the memo.
  const memos = new Map<string, Group>();
  for (const t of tx.filter((t) => t.type === "DEBIT" && !t.counterparty && t.category === "Transfers")) {
    const memo = memoOf(t.description);
    if (!memo || answered(memo)) continue;
    const g: Group = memos.get(memo) ?? { key: memo, display: memo, total: 0n, count: 0, examples: [], descriptions: [], categories: new Map() };
    g.total += t.amountMinor;
    g.count++;
    (g.hits ??= []).push({ minor: t.amountMinor, date: t.transactionDate });
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
      totalMinor: g.total, count: g.count, examples: g.examples, options: PERSON_OPTIONS,
    });
  }

  // Regular payments first among equals: one answer covers every future month.
  const weight = (q: Question) => (/around the \d+(st|nd|rd|th)/.test(q.prompt) ? q.totalMinor * 2n : q.totalMinor);
  const rank = (q: Question) => (q.kind === "holder" ? 0 : q.kind === "conversion" ? 1 : 2);
  questions.sort((a, b) => rank(a) - rank(b) || (weight(b) > weight(a) ? 1 : -1));
  // Holder first, then by money affected.
  return questions.slice(0, limit);
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
  other?: { text: string; category?: string },
): Promise<number> {
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
