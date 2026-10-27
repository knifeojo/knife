import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { BASE_CURRENCY, fxRates, monthPeriod, specificMonth, type Period } from "./analytics";
import { OWN_TRANSFER, sameName } from "./categorize";

// The user's own notes ("Wife 750", "Loan: Rm 1.3, Fm 400") COMPLEMENT the bank data:
// they explain what payments were for. They never change an amount, date or balance, never
// overwrite a label the user already gave, and never create duplicates.

export interface NoteLine {
  label: string;
  amountMinor?: bigint;
  children: NoteLine[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Amounts as people jot them: "750" = ₦750K, "1.3" = ₦1.3M, "1m", "90 k", "400k", "1,200,000".
 * Bare numbers under 10,000 are thousands; bare decimals under 10 are millions.
 */
export function parseNoteAmount(raw: string): bigint | undefined {
  const m = raw.replace(/,/g, "").trim().match(/^(\d+(?:\.\d+)?)\s*(k|m|million|thousand)?$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  const naira = unit === "m" || unit === "million" ? n * 1_000_000
    : unit === "k" || unit === "thousand" ? n * 1_000
    : m[1].includes(".") && n < 10 ? n * 1_000_000
    : n < 10_000 ? n * 1_000
    : n;
  return BigInt(Math.round(naira * 100));
}

/** Parses an indented checklist; a heading with sub-items becomes a parent line. */
export function parseNotes(text: string): NoteLine[] {
  const root: NoteLine[] = [];
  const stack: { indent: number; line: NoteLine }[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^\s*/)![0].replace(/\t/g, "    ").length;
    const body = raw.trim().replace(/^[-*•✓☑✔]\s*/, "").replace(/:$/, "");
    if (/^expenses?\b/i.test(body)) continue; // a month heading, handled by the caller
    const m = body.match(/^(.*?)[\s:]*((?:\d[\d,]*(?:\.\d+)?)\s*(?:k|m|million|thousand)?)\s*$/i);
    const label = (m ? m[1] : body).replace(/(\D)(\d)/, "$1 $2").trim() || body;
    const line: NoteLine = { label: label.replace(/\s+/g, " "), amountMinor: m ? parseNoteAmount(m[2]) : undefined, children: [] };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    (stack.length ? stack[stack.length - 1].line.children : root).push(line);
    stack.push({ indent, line });
  }
  return root;
}

export function monthFromHeading(text: string, year: number): Period | undefined {
  const m = text.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  return m ? specificMonth(year, MONTHS.indexOf(m[1])) : undefined;
}

interface Tx {
  id: string;
  date: Date;
  amountMinor: bigint; // in naira (foreign converted at the user's rate)
  currency: string;
  originalMinor: bigint;
  description: string;
  counterparty: string | null;
  merchantName: string | null;
  category: string;
  subcategory: string | null;
  classificationSource: string;
}

export interface NoteMatch {
  label: string;
  path: string; // "House fixing › Curtain"
  notedMinor?: bigint;
  matched: { id: string; date: string; amount: string; description: string; label: string; userLabelled: boolean }[];
  matchedMinor: bigint;
  status: "matches" | "close" | "partly found" | "bank shows more" | "not in your statements" | "no amount";
  how: string; // why these transactions were picked
  proposal?: { category: string; subcategory: string };
}

const STOP = new Set(["and", "the", "for", "my", "to", "of", "other", "house", "light", "charge"]);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w));
const hasWord = (desc: string, w: string) => new RegExp(`\\b${w.replace(/[^a-z0-9]/g, "")}\\b`, "i").test(desc);

/** What a note line means: how to find it in the ledger, and the label it suggests. */
function interpret(label: string, parent: string | undefined, aliases: { pattern: string; category: string | null; subcategory: string | null }[]) {
  const l = label.toLowerCase();
  const people = (re: RegExp) => aliases.filter((a) => a.pattern.includes(" ") && re.test(`${a.subcategory ?? ""} ${a.category ?? ""}`)).map((a) => a.pattern);
  if (/^wife|^husband|^partner|^spouse/.test(l)) return { people: people(/partner|wife|husband|spouse/i), proposal: { category: "Family", subcategory: "Spouse" }, how: "the person you labelled as your partner" };
  if (/^parents?$/.test(l)) return { people: people(/\b(dad|mum|mom|mother|father|parent|in ?law)/i), proposal: { category: "Family", subcategory: "Parents" }, how: "the people you labelled as parents and in-laws" };
  if (/^rm\b|renmoney/.test(l)) return { words: ["renmoney", "remb"], proposal: { category: "Debt", subcategory: "Renmoney loan" }, how: "Renmoney" };
  if (/^fm\b|fairmoney/.test(l)) return { words: ["fairmoney"], proposal: { category: "Debt", subcategory: "FairMoney loan" }, how: "FairMoney" };
  if (/^tite|^tithe/.test(l)) return { words: ["tithe", "tite", "grace", "church"], proposal: { category: "Giving", subcategory: "Tithe" }, how: "payments to your church" };
  if (/^saving/.test(l)) return { categories: [OWN_TRANSFER], words: ["saving", "savings", "piggyvest", "cowrywise"], proposal: { category: OWN_TRANSFER, subcategory: "Savings" }, how: "transfers to your savings" };
  if (/service charge|house light/.test(l)) return { words: ["service", "homeserve", "electric", "light", "nepa"], proposal: { category: "Housing", subcategory: "Light and service charge" }, how: "service charge and electricity payments" };
  if (/^staff/.test(l)) return { categories: ["Housing"], subcategories: ["Home services"], proposal: { category: "Housing", subcategory: "Staff" }, how: "people you labelled as staff or home services" };
  if (/^subscription/.test(l)) return { words: ["subscription", "subscriptions"], categories: ["Subscriptions"], proposal: { category: "Subscriptions", subcategory: "Subscriptions" }, how: "subscriptions" };
  if (/^dd$/.test(l)) return { words: ["dd"], proposal: { category: "Housing", subcategory: "Rent and DD" }, how: "your \"DD\" memo" };
  if (/^rent$/.test(l)) return { words: ["rent"], proposal: { category: "Housing", subcategory: "Rent and DD" }, how: "your \"RENT\" memo" };
  if (/\bac\b/.test(l)) return { words: ["ac", "aircon", "air"], merchants: ["fouani"], proposal: { category: "Housing", subcategory: "Air conditioning" }, how: "AC payments and appliance stores" };
  const base = parent && /house fixing|repairs?/i.test(parent) ? "Housing" : parent && /shoo?ping/i.test(parent) ? "Shopping" : undefined;
  if (/food ?stuff|groceries|meat|market/.test(l)) return { words: words(label), categories: ["Food"], proposal: { category: "Food", subcategory: label }, how: "your memo and food spending" };
  if (/csr/.test(l)) return { words: ["csr"], proposal: { category: "Other", subcategory: "CSR" }, how: "your \"CSR\" memo" };
  return { words: words(label), proposal: { category: base ?? "Other", subcategory: label }, how: `your "${label.toUpperCase()}" memo` };
}

// Notes are rough work, so amounts are compared loosely: they guide matching, they're never checked.
const roughlyEqual = (a: bigint, b: bigint, pct = 30n) => (a > b ? a - b : b - a) * 100n <= b * pct;

function statusFor(noted: bigint | undefined, found: bigint): NoteMatch["status"] {
  if (noted === undefined) return "no amount";
  if (found === 0n) return "not in your statements";
  if (roughlyEqual(found, noted, 10n)) return "matches";
  if (roughlyEqual(found, noted, 35n)) return "close";
  return found < noted ? "partly found" : "bank shows more";
}

/**
 * The payment(s) that best explain a rough note amount: the single closest payment if one is near,
 * otherwise the largest payments until roughly the noted total (so small extras aren't swept in).
 */
export function pickClosest<T extends { amountMinor: bigint }>(xs: T[], noted: bigint): T[] {
  const gap = (t: T) => (t.amountMinor > noted ? t.amountMinor - noted : noted - t.amountMinor);
  const near = xs.filter((t) => roughlyEqual(t.amountMinor, noted)).sort((a, b) => (gap(a) < gap(b) ? -1 : 1));
  if (near.length) return [near[0]];
  const kept: T[] = [];
  let total = 0n;
  for (const t of [...xs].sort((a, b) => (b.amountMinor > a.amountMinor ? 1 : -1))) {
    if (total * 100n >= noted * 85n) break;
    if ((total + t.amountMinor) * 100n <= noted * 130n) {
      kept.push(t);
      total += t.amountMinor;
    }
  }
  return kept;
}

/**
 * Matches each note line to the month's transactions (with a week's grace either side). Lines with
 * their own memo or person are claimed first, so broad lines ("Shopping") don't take specific ones.
 */
export async function matchNotes(userId: string, period: Period, lines: NoteLine[]): Promise<NoteMatch[]> {
  const grace = 7 * 86400_000;
  const [rows, aliases, rates] = await Promise.all([
    db.transaction.findMany({
      where: { userId, type: "DEBIT", category: { not: "Fees" }, transactionDate: { gte: new Date(period.from.getTime() - grace), lt: new Date(period.to.getTime() + grace) } },
      orderBy: { transactionDate: "asc" },
    }),
    db.merchantAlias.findMany({ where: { userId, category: { not: null } }, select: { pattern: true, category: true, subcategory: true } }),
    fxRates(userId),
  ]);
  const txs: Tx[] = rows.flatMap((r) => {
    const fx = r.currency === BASE_CURRENCY ? 1 : rates.get(r.currency)?.rate;
    if (!fx) return [];
    // Only spending and own-account saving; skip the receiving leg of transfers between accounts.
    return [{ id: r.id, date: r.transactionDate, amountMinor: BigInt(Math.round(Number(r.amountMinor) * fx)), currency: r.currency, originalMinor: r.amountMinor, description: r.description, counterparty: r.counterparty, merchantName: r.merchantName, category: r.category, subcategory: r.subcategory, classificationSource: r.classificationSource }];
  });

  // Flatten to leaves (a heading with sub-items is reported as the sum of its sub-items)
  type Leaf = { line: NoteLine; path: string; parent?: string };
  const leaves: Leaf[] = [];
  const walk = (ls: NoteLine[], parents: string[]) => {
    for (const l of ls) {
      if (l.children.length && !l.children.every((c) => c.children.length === 0 && /^(bal|adv|advance|balance)/i.test(c.label))) walk(l.children, [...parents, l.label]);
      else leaves.push({ line: l, path: [...parents, l.label].join(" › "), parent: parents[parents.length - 1] });
    }
  };
  walk(lines, []);

  const claimed = new Set<string>();
  const results = new Map<Leaf, NoteMatch>();
  const inMonth = (t: Tx) => t.date >= period.from && t.date < period.to;
  const desc = (t: Tx) => `${t.description} ${t.counterparty ?? ""} ${t.merchantName ?? ""}`;
  const sum = (xs: Tx[]) => xs.reduce((s, x) => s + x.amountMinor, 0n);
  const interpreted = leaves.map((leaf) => ({ leaf, it: interpret(leaf.line.label, leaf.parent, aliases) }));
  const record = (leaf: Leaf, it: ReturnType<typeof interpret>, picks: Tx[], found: bigint, how = it.how) => {
    for (const p of picks) claimed.add(p.id);
    results.set(leaf, {
      label: leaf.line.label,
      path: leaf.path,
      notedMinor: leaf.line.amountMinor,
      matched: picks.map((t) => ({
        id: t.id,
        date: new Date(t.date.getTime() + 3600_000).toISOString().slice(0, 10),
        amount: t.currency === BASE_CURRENCY ? formatMoney(t.originalMinor) : `${formatMoney(t.originalMinor, t.currency)} (≈ ${formatMoney(t.amountMinor)})`,
        description: t.description.replace(/\d{10,}/g, "…").slice(0, 90),
        label: [t.category, t.subcategory].filter(Boolean).join(" / "),
        userLabelled: t.classificationSource === "user",
      })),
      matchedMinor: found,
      status: statusFor(leaf.line.amountMinor, found),
      how,
      proposal: it.proposal,
    });
  };

  // One payment for several lines: "RENT AND DD" ₦1M covers both "Rent 500" and "Dd 500k".
  const memoLines = interpreted.filter(({ it }) => "words" in it && it.words?.length && !("people" in it));
  for (const t of txs.filter(inMonth)) {
    const hits = memoLines.filter(({ leaf, it }) => !results.has(leaf) && leaf.line.amountMinor && it.words!.some((w) => hasWord(desc(t), w)));
    if (hits.length < 2) continue;
    const noted = hits.reduce((s, h) => s + h.leaf.line.amountMinor!, 0n);
    if (!roughlyEqual(t.amountMinor, noted)) continue;
    const names = hits.map((h) => h.leaf.line.label).join(" + ");
    for (const h of hits) record(h.leaf, h.it, [t], h.leaf.line.amountMinor!, `one payment covering ${names}`);
  }

  // Then specific lines (people, named lenders, memos) before broad categories.
  const ranked = interpreted
    .filter(({ leaf }) => !results.has(leaf))
    .sort((a, b) => Number(!!a.it.categories && !a.it.words?.length) - Number(!!b.it.categories && !b.it.words?.length));
  for (const { leaf, it } of ranked) {
    const candidates = txs.filter((t) => !claimed.has(t.id) && (
      ("people" in it && it.people?.some((p) => sameName(t.counterparty ?? "", p))) ||
      ("words" in it && it.words?.some((w) => hasWord(desc(t), w))) ||
      ("merchants" in it && it.merchants?.some((m) => desc(t).toLowerCase().includes(m))) ||
      ("categories" in it && it.categories?.includes(t.category) && (!("subcategories" in it) || it.subcategories?.includes(t.subcategory ?? "")))
    ));
    const noted = leaf.line.amountMinor;
    let picks = candidates.filter(inMonth);
    if (noted !== undefined) {
      picks = pickClosest(picks, noted);
      // Paid a few days either side of the month: look in the grace week only if the month falls short.
      if (sum(picks) * 100n < noted * 85n) picks = pickClosest(candidates, noted);
    }
    record(leaf, it, picks, sum(picks));
  }
  return leaves.map((l) => results.get(l)!);
}

/**
 * Applies a note's purpose to its matched transactions. Rows the user already labelled are left
 * alone (they're shown as differing instead). Amounts and dates are never touched.
 */
export async function applyNoteLabel(userId: string, transactionIds: string[], proposal: { category: string; subcategory: string }) {
  const res = await db.transaction.updateMany({
    where: { userId, id: { in: transactionIds }, classificationSource: { not: "user" } },
    data: { category: proposal.category, subcategory: proposal.subcategory.slice(0, 40), classificationSource: "user", classificationConfidence: 1 },
  });
  return res.count;
}

export function defaultNotesPeriod(now = new Date()): Period {
  return monthPeriod(now, -1);
}
