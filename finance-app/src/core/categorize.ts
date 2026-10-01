import type { Classification, TransactionType } from "./types";

export const EXPENSE_CATEGORIES = [
  "Food", "Transport", "Housing", "Utilities", "Shopping", "Subscriptions", "Family",
  "Debt", "Healthcare", "Travel", "Business", "Transfers", "Fees", "Other",
] as const;
export const INCOME_CATEGORY = "Income";
export const INCOME_SUBCATEGORIES = ["Salary", "Consulting", "Business income", "Transfer", "Refund", "Interest", "Other income"] as const;
/** Moves between the user's own accounts. Excluded from both income and spending totals. */
export const OWN_TRANSFER = "Own transfer";
export const ALL_CATEGORIES = [...EXPENSE_CATEGORIES, INCOME_CATEGORY, OWN_TRANSFER];

interface Rule {
  match: RegExp;
  merchant?: string;
  category: string;
  subcategory?: string;
  only?: TransactionType;
}

// Ordered: first match wins. Patterns run against the lowercased description.
const RULES: Rule[] = [
  // Income
  { match: /salary|payroll|\bsal\b/, category: INCOME_CATEGORY, subcategory: "Salary", only: "CREDIT" },
  { match: /upwork/, merchant: "Upwork", category: INCOME_CATEGORY, subcategory: "Consulting", only: "CREDIT" },
  { match: /deel|remote\.com|payoneer|fiverr|toptal/, category: INCOME_CATEGORY, subcategory: "Consulting", only: "CREDIT" },
  { match: /invoice|consult/, category: INCOME_CATEGORY, subcategory: "Consulting", only: "CREDIT" },
  { match: /refund|reversal|\brvsl\b|\brev\//, category: INCOME_CATEGORY, subcategory: "Refund", only: "CREDIT" },
  { match: /interest capitali[sz]ed|interest run|int\.? ?pd|interest paid|credit interest/, merchant: "Interest", category: INCOME_CATEGORY, subcategory: "Interest", only: "CREDIT" },
  { match: /\bpesa\b(?!peer)| pesa payments/, merchant: "Pesa", category: INCOME_CATEGORY, subcategory: "Transfer", only: "CREDIT" },

  // Fees
  // PDFs sometimes glue words ("VATCHARGES", "TransferCHARGES"), so these avoid leading word boundaries.
  { match: /sms alert|alert charge|commission|stamp duty|\bvat|maintenance fee|card maint|\bcot\b|nip charge|transfer charge|charges?\b|transfer levy|\bemtl\b/, merchant: "Bank charges", category: "Fees" },

  // Cash
  { match: /\batm\b|cash wdl|cash withdrawal|\bwdl\b/, merchant: "Cash withdrawal", category: "Other", subcategory: "Cash" },

  // Transport
  { match: /\buber\b/, merchant: "Uber", category: "Transport", subcategory: "Ride hailing" },
  { match: /\bbolt\b|taxify/, merchant: "Bolt", category: "Transport", subcategory: "Ride hailing" },
  { match: /indrive|lagride|rida\b/, merchant: "inDrive", category: "Transport", subcategory: "Ride hailing" },
  { match: /total ?energies|\bmobil\b|oando|conoil|ardova|nnpc|filling station|\bfuel\b|\bdiesel\b|\bpetrol\b/, category: "Transport", subcategory: "Fuel" },
  { match: /\blcc\b|toll/, category: "Transport", subcategory: "Tolls" },

  // Subscriptions
  { match: /netflix/, merchant: "Netflix", category: "Subscriptions", subcategory: "Streaming" },
  { match: /spotify/, merchant: "Spotify", category: "Subscriptions", subcategory: "Streaming" },
  { match: /showmax/, merchant: "Showmax", category: "Subscriptions", subcategory: "Streaming" },
  { match: /youtube/, merchant: "YouTube", category: "Subscriptions", subcategory: "Streaming" },
  { match: /apple\.com|itunes|icloud/, merchant: "Apple", category: "Subscriptions" },
  { match: /openai|chatgpt/, merchant: "OpenAI", category: "Subscriptions", subcategory: "Software" },
  { match: /anthropic|claude\.ai/, merchant: "Anthropic", category: "Subscriptions", subcategory: "Software" },
  { match: /google \*|google\.com|gsuite|workspace/, merchant: "Google", category: "Subscriptions", subcategory: "Software" },
  { match: /canva|notion|figma|slack|zoom/, category: "Subscriptions", subcategory: "Software" },

  // Utilities
  { match: /\bdstv\b|\bgotv\b|multichoice/, merchant: "MultiChoice", category: "Utilities", subcategory: "TV" },
  { match: /ikeja electric|ekedc|eko electric|aedc|phcn|prepaid meter|electricity/, category: "Utilities", subcategory: "Electricity" },
  { match: /spectranet|starlink|smile|fibre|internet/, category: "Utilities", subcategory: "Internet" },
  { match: /\bmtn\b|airtel|\bglo\b|9mobile|airtime|data bundle|\bvtu\b/, category: "Utilities", subcategory: "Airtime & data" },
  { match: /lawma|water/, category: "Utilities" },

  // Food and groceries
  { match: /shoprite/, merchant: "Shoprite", category: "Food", subcategory: "Groceries" },
  { match: /\bspar\b/, merchant: "Spar", category: "Food", subcategory: "Groceries" },
  { match: /ebeano|justrite|market square|hubmart|supermarket/, category: "Food", subcategory: "Groceries" },
  { match: /chowdeck/, merchant: "Chowdeck", category: "Food", subcategory: "Delivery" },
  { match: /glovo/, merchant: "Glovo", category: "Food", subcategory: "Delivery" },
  { match: /chicken republic|kfc|domino|cold stone|mr bigg|sweet sensation|kilimanjaro|the place|restaurant|cafe|eatery/, category: "Food", subcategory: "Eating out" },

  // Shopping
  { match: /jumia/, merchant: "Jumia", category: "Shopping" },
  { match: /konga/, merchant: "Konga", category: "Shopping" },
  { match: /amazon|aliexpress|temu|shein/, category: "Shopping", subcategory: "Online" },

  // Housing
  { match: /\brent\b|landlord|service charge|estate dues/, category: "Housing", subcategory: "Rent" },

  // Healthcare
  { match: /pharmac|medplus|hospital|clinic|\bhmo\b|diagnostic/, category: "Healthcare" },

  // Travel
  { match: /air peace|arik|ibom air|united nigeria|emirates|qatar airways|british airways|booking\.com|airbnb|hotel/, category: "Travel" },

  // Debt
  { match: /loan repay|carbon|fairmoney|palmcredit|renmoney|\bremb\b|credit card/, merchant: undefined, category: "Debt", subcategory: "Loan repayment" },

  // Family / education
  { match: /school fees|tuition/, category: "Family", subcategory: "Education" },

  // Business
  { match: /\bcac\b|\bfirs\b|tax payment|remita/, category: "Business", subcategory: "Tax & compliance" },

  // Memo keywords people type on transfers ("CLOTHES TO ...", "HAIR TO ...", "LOAN TO ...")
  { match: /\b(clothes|clothing|fashion|boutique|shoes?|tailor|fabric|aso ?ebi)\b/, category: "Shopping", subcategory: "Clothing" },
  { match: /\b(hair|salon|barb(er|ing)|spa|nails?|make ?up|lashes|pedicure|manicure)\b/, category: "Shopping", subcategory: "Personal care" },
  { match: /\b(cleaning|cleaner|laundry|dry ?clean|gardener|security|plumber|electrician|fumigation|generator repair|house ?help|nanny|maid)\b/, category: "Housing", subcategory: "Home services" },
  { match: /\b(tyres?|tires?|mechanic|vulcani[sz]er|car wash|car repair|spare parts?|autos?\b|panel beat)/, category: "Transport", subcategory: "Car" },
  { match: /\b(birthday|gift|wedding|condolence|baby shower|bday)\b/, category: "Family", subcategory: "Gifts" },
  { match: /\b(daddy|daddys|dad|father|mummy|mummys|mum|mom|mother|parents|upkeep|allowance|pocket money|feeding)\b/, category: "Family", subcategory: "Family support" },
  { match: /\b(tithe|offering|church|mosque|zakat|donation|charity|seed)\b/, category: "Other", subcategory: "Giving" },
  { match: /\b(food ?stuff|groceries|market|lunch|dinner|breakfast|food)\b/, category: "Food" },
  { match: /\bsubscriptions?\b/, category: "Subscriptions" },
  { match: /\b(loan|lend|borrow)\b/, category: "Debt", subcategory: "Loans" },
  { match: /\b(sq ?uad|squad|paystack|flutterwave|interswitch|opay merchant|monnify)\b/, category: "Shopping", subcategory: "Online payment" },
];

// Merchant normalization: noisy narrations -> one canonical name ("UBER *TRIP", "UBER BV" -> "Uber").
// Global aliases here; user corrections add user-scoped aliases in the merchant_aliases table.
const MERCHANT_ALIASES: [RegExp, string][] = [
  [/\buber\b/, "Uber"], [/\bbolt\b|taxify/, "Bolt"], [/indrive/, "inDrive"],
  [/total ?energies/, "TotalEnergies"], [/conoil/, "Conoil"], [/\bmobil\b/, "Mobil"], [/oando/, "Oando"], [/nnpc/, "NNPC"],
  [/cold stone/, "Cold Stone Creamery"], [/chicken republic/, "Chicken Republic"], [/\bkfc\b/, "KFC"], [/domino/, "Domino's"],
  [/the place/, "The Place"], [/kilimanjaro/, "Kilimanjaro"], [/chowdeck/, "Chowdeck"], [/glovo/, "Glovo"],
  [/shoprite/, "Shoprite"], [/\bspar\b/, "Spar"], [/ebeano/, "Ebeano"], [/justrite/, "Justrite"],
  [/netflix/, "Netflix"], [/spotify/, "Spotify"], [/showmax/, "Showmax"], [/openai|chatgpt/, "OpenAI"], [/anthropic|claude\.ai/, "Anthropic"],
  [/apple\.com|itunes|icloud/, "Apple"], [/\bdstv\b|\bgotv\b|multichoice/, "MultiChoice"],
  [/ikeja electric/, "Ikeja Electric"], [/ekedc|eko electric/, "Eko Electric"], [/spectranet/, "Spectranet"], [/starlink/, "Starlink"],
  [/\bmtn\b/, "MTN"], [/airtel/, "Airtel"], [/\bglo\b/, "Glo"],
  [/jumia/, "Jumia"], [/konga/, "Konga"], [/amazon/, "Amazon"], [/air peace/, "Air Peace"], [/ibom air/, "Ibom Air"],
  [/medplus/, "MedPlus"], [/carbon/, "Carbon"], [/fairmoney/, "FairMoney"], [/renmoney|\bremb\b/, "Renmoney"], [/piggyvest/, "PiggyVest"], [/cowrywise/, "Cowrywise"],
  [/upwork/, "Upwork"], [/payoneer/, "Payoneer"], [/\bpesa\b(?!peer)/, "Pesa"],
];

export function normalizeMerchant(description: string): string | undefined {
  const d = description.toLowerCase();
  return MERCHANT_ALIASES.find(([re]) => re.test(d))?.[1];
}

const TRANSFER_MARKER = /\b(trf|nip|fip|transfer|mob\/utu|ussd)\b|instant payment|outward|inward/;

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();
}

// Bank and wallet short codes that appear between "TO" and the recipient name, e.g. "TO ZBN - FOUANI".
const BANK_CODE = /^(zbn|zenith( bank)?|fcmb|gtb|gtbank|gtco|uba|access( bank)?|abp|fbn|first ?bank|fbnquest|stanbic( ibtc)?|wema|alat|sterling|fidelity|fbp|ecobank|eco|polaris|union( bank)?|keystone|providus|heritage|jaiz|suntrust|titan|paystacktitan|paystack ?titan|globus|premium ?trust|optimus|parallex|lotus|taj|signature|moniemfb|monie ?mfb|moniepoint|moniemf ?b|opay|palmpay|kuda( mfb)?|kudamfb|carbon|fairmoney|vfd|vbank|rubies|paga|mint|sparkle|safe ?haven|eyowo|9psb|9 ?mobile ?psb|momo ?psb|hope ?psb|smartcash|piggyvest|cowrywise|risevest|chipper|lapo|baobab|renmoney|accion|fina ?trust|unity|citi(bank)?|standard chartered|scb|coronation|rand ?merchant|nova|greenwich|fsdh|aella|wramfb|fairmoney mfb|[a-z ]+ ?(mfb|psb|microfinance( bank)?|bank))$/i;

function cleanName(s: string): string | undefined {
  const t = s
    .replace(/[^A-Za-z .'&-]/g, " ")
    .replace(/\s+/g, " ")
    // PDF line wraps split words ("EZ E", "SHOWROO M"): rejoin a lone trailing letter
    .replace(/\b([A-Za-z]{2,}) ([A-Za-z])\b(?! [A-Za-z]\b)/g, "$1$2")
    .replace(/(\s+[A-Za-z]){1,3}$/, "") // dangling single letters at the end ("RETAI L A")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .trim();
  return t.length >= 2 ? titleCase(t).slice(0, 48) : undefined;
}

/** Recipient after "TO". Skips a leading bank code ("TO ZBN - FOUANI SHOWROOM" -> "Fouani Showroom"). */
function recipientAfterTo(d: string): string | undefined {
  const idx = d.search(/\bTO\s+/i);
  if (idx < 0) return undefined;
  const rest = d.slice(idx).replace(/^TO\s+/i, "");
  const parts = rest.split(/\s+-\s+|\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  let i = 0;
  if (BANK_CODE.test(parts[0].replace(/[^A-Za-z ]/g, "").trim())) i = 1;
  const candidate = parts[i];
  if (!candidate) return undefined;
  // Stop at the first digit or full stop inside the name segment.
  return cleanName(candidate.split(/\d|\.(?:\s|$)/)[0]);
}

/** Sender of an inward transfer written as "...-RECIPIENT-CODE-SENDER" or "XXXX-MONIE MFB-DEEL INC". */
function senderFromDashes(d: string): string | undefined {
  const segs = d.split("-").map((x) => x.trim()).filter((x) => /[A-Za-z]{3,}/.test(x));
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i].replace(/[^A-Za-z .'&]/g, " ").replace(/\s+/g, " ").trim();
    if (!seg || BANK_CODE.test(seg) || /^(transfer|nip|inc|ltd)$/i.test(seg)) continue;
    return cleanName(seg);
  }
  return undefined;
}

/** Best effort counterparty from Nigerian transfer narrations, e.g. "TRF/RENT/FRM A TO B" or "NIP/ACME LTD/SALARY". */
export function extractCounterparty(description: string, type: TransactionType): string | undefined {
  const d = description.replace(/\s+/g, " ");
  if (type === "DEBIT") {
    const r = recipientAfterTo(d);
    if (r) return r;
  }
  const from = d.match(/\b(?:FROM|FRM)\s+([A-Z][A-Z .'-]{2,60}?)(?:\s+TO\b|\s*\/|$)/i);
  if (type === "CREDIT" && from) return titleCase(from[1]);
  const nip = d.match(/^(?:NIP|FIP|TRF)\/([^/]{3,60})\//i);
  if (nip) return titleCase(nip[1]);
  // Wallet statements: "PESAPEER INC / Payroll for Sep 2026" -> the payer is the part before the first " / ".
  const slash = d.match(/^([A-Z][A-Za-z0-9 .&'-]{2,50}?)\s+\/\s+\S/);
  if (type === "CREDIT" && slash && !/^(money transfer|transfer|payment|deposit|nip|trf)\b/i.test(slash[1])) return cleanName(slash[1]);
  if (type === "CREDIT" && (d.match(/-/g) ?? []).length >= 1) return senderFromDashes(d);
  return undefined;
}

/** The account holder, inferred from debits that read "FROM <holder> TO <someone>". Bank-agnostic. */
export function inferHolderName(descriptions: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const d of descriptions) {
    const m = d.toUpperCase().match(/\bFROM\s+([A-Z][A-Z .'-]{3,60}?)\s+TO\b/);
    if (!m || /\b(WALLET|ACCOUNT|CARD|SAVINGS|CURRENT|NGN|USD|CAD|GBP|EUR)\b/.test(m[1])) continue;
    const key = m[1].replace(/[^A-Z]/g, "");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 2) return undefined;
  // Return the most common spaced spelling for display
  const spelled = descriptions.map((d) => d.toUpperCase().match(/\bFROM\s+([A-Z][A-Z .'-]{3,60}?)\s+TO\b/)?.[1]).find((x) => x && x.replace(/[^A-Z]/g, "") === best[0]);
  return spelled?.trim();
}

export interface NameHint {
  label: string; // what the name suggests they do, shown to the user
  category: string;
  subcategory?: string;
}

// Trade words inside recipient names ("J'STITCHES COUTURE", "EKANATURALS", "EBUBECHUKWUINTERIOR").
// Matched without word boundaries because Nigerian business names often run words together.
const NAME_HINTS: [RegExp, NameHint][] = [
  [/stitch|couture|tailor|fashion|fabric|textile|boutique|apparel|clothing|wears|kiddies/, { label: "Tailor or clothing", category: "Shopping", subcategory: "Clothing" }],
  [/shoe|footwear|sneaker/, { label: "Shoes", category: "Shopping", subcategory: "Clothing" }],
  [/natural|hair|salon|beauty|cosmetic|skincare|spa\b|nails|lash|barb/, { label: "Hair or beauty", category: "Shopping", subcategory: "Personal care" }],
  [/interior|furnitur|decor|curtain|upholster|tiles|paint/, { label: "Interior or furniture", category: "Housing", subcategory: "Home & furnishing" }],
  [/showroom|electronic|appliance|gadget|phones?\b|mobile ?world|computers?|fouani|slot\b|pointek/, { label: "Electronics store", category: "Shopping", subcategory: "Electronics" }],
  [/lounge|\bbar\b|grill|kitchen|restaurant|eatery|bistro|delis?\b|bakery|cafe|suya|shawarma|pizza|catering|chops/, { label: "Food or drinks place", category: "Food", subcategory: "Eating out" }],
  [/supermarket|stores?\b|\bmart\b|mall|provisions|groceries|market/, { label: "Shop or supermarket", category: "Food", subcategory: "Groceries" }],
  [/pharm|chemist|clinic|hospital|medical|health|diagnostic|dental|optical|lab(oratory)?\b/, { label: "Health provider", category: "Healthcare" }],
  [/autos?\b|motors?|mechanic|garage|tyres?|vulcan|car ?wash|spare/, { label: "Car services", category: "Transport", subcategory: "Car" }],
  [/logistic|delivery|dispatch|courier|express\b|haulage|movers/, { label: "Delivery or logistics", category: "Transport", subcategory: "Delivery" }],
  [/school|academy|college|tutor|lesson|creche|montessori|university/, { label: "School or tutoring", category: "Family", subcategory: "Education" }],
  [/propert|realt|homes\b|estate|apartment|shortlet|facility/, { label: "Property or estate", category: "Housing" }],
  [/travel|tours|airline|airways|hotel|suites|resort|booking/, { label: "Travel", category: "Travel" }],
  [/gym|fitness|wellness|yoga/, { label: "Fitness", category: "Healthcare", subcategory: "Fitness" }],
  [/church|ministr|chapel|mosque|cathedral|parish|christian|gospel|fellowship/, { label: "Church or religious body", category: "Other", subcategory: "Giving" }],
  [/foundation|charity|ngo\b|trust fund/, { label: "Charity", category: "Other", subcategory: "Giving" }],
  [/event|planner|decorations|rentals|photograph|studio|media|print/, { label: "Events or media", category: "Shopping", subcategory: "Services" }],
  [/laundry|dry ?clean|cleaning|fumigat/, { label: "Cleaning service", category: "Housing", subcategory: "Home services" }],
  [/insurance|assurance/, { label: "Insurance", category: "Business", subcategory: "Insurance" }],
  [/energy|power|solar|electric|gas\b/, { label: "Energy or power", category: "Utilities" }],
];

const LEGAL_SUFFIX = /\b(ltd|limited|inc|plc|llc|enterprises?|ventures|nig(eria)?|global|concepts?|services|company|co)\b/i;

/** What a recipient's name suggests: a kind of business, any business, or (no hint) a person. */
export function nameHint(name: string | undefined): NameHint | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  const hit = NAME_HINTS.find(([re]) => re.test(n));
  if (hit) return hit[1];
  if (LEGAL_SUFFIX.test(n)) return { label: "A business", category: "Shopping", subcategory: "Vendors" };
  return undefined;
}

/** Name words, uppercase letters only ("Mensah Abena-Akosua" -> MENSAH, ABENA, AKOSUA). */
export function nameTokens(name: string): string[] {
  return name.toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 2);
}

/**
 * Same person when one name's words are contained in the other's (any order, ignoring spacing), or
 * when two of three names match: "Abena Mensah" = "MENSAH ABENA AKOSUA" = "ABENA AKOSUA ADE".
 */
export function sameName(a: string, b: string): boolean {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (ta.length < 2 || tb.length < 2) return false;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const bigJoined = big.join("");
  // Short fragments must match exactly; longer words may match across stray spaces ("OL UWASEUN").
  const shared = small.filter((t) => big.includes(t) || (t.length >= 4 && bigJoined.includes(t))).length;
  if (shared === small.length) return true;
  // Two of three names matching is the same person ("Mensah Abena Akosua" = "Abena Mensah Ama").
  // Two-word names must match fully: a shared surname alone ("Eze") would merge different relatives.
  return small.length >= 3 && shared >= small.length - 1 && shared >= 2;
}

const NARRATION_WORDS = /\b(transfer|payment|outward|inward|instant|pos|web|nip|purchase|trf|charges?|commission|airtime|to|from|via)\b/i;

/** A saved rule pattern that is a person's or company's name (matched on counterparty, never on free text). */
function isNamePattern(p: string): boolean {
  const words = p.trim().split(/\s+/);
  return words.length >= 2 && words.length <= 5 && !/\d/.test(p) && !NARRATION_WORDS.test(p);
}

/** True when a counterparty is the account holder (spacing-insensitive, needs two name parts). */
export function isSelf(counterparty: string | undefined, owners: string[]): boolean {
  if (!counterparty) return false;
  const cp = counterparty.toUpperCase().replace(/[^A-Z]/g, "");
  return owners.some((o) => {
    const tokens = o.toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 3);
    const hits = tokens.filter((t) => cp.includes(t)).length;
    return hits >= 2 && cp.length <= tokens.join("").length + 6;
  });
}

const COMPANY = /\b(ltd|limited|inc|plc|llc|corp|corporation|company|enterprises?|ventures|technologies|tech|services|global|group|holdings|nig(eria)?|payments?|solutions)\b/i;

export interface UserRule {
  pattern: string;
  canonicalName: string;
  category?: string | null;
  subcategory?: string | null;
}

/** Key used to learn from user corrections: merchant name when known, else the counterparty, else cleaned narration. */
export function learningKey(description: string, merchantName?: string | null, counterparty?: string | null): string {
  if (merchantName) return merchantName.toLowerCase();
  if (counterparty) return counterparty.toLowerCase();
  return description.toLowerCase().replace(/[0-9]+/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

/**
 * Deterministic categorization. Only proposes merchant/category/subcategory; it never sees or
 * returns amount, date or reference, so it cannot alter them.
 */
export function categorize(
  input: { description: string; type: TransactionType },
  userRules: UserRule[] = [],
  /** Account holder name(s), so transfers between the user's own accounts are not counted as income or spending. */
  owners: string[] = [],
): Classification {
  const desc = input.description.toLowerCase();
  const rawCounterparty = extractCounterparty(input.description, input.type);
  // A recipient that is a known business gets its proper name ("Remb" -> "Renmoney").
  const counterparty = rawCounterparty ? (normalizeMerchant(rawCounterparty) ?? rawCounterparty) : undefined;
  const merchant = normalizeMerchant(input.description);

  // Bank charges are always fees, even when they name the person the transfer went to
  // ("Commission on NIP Transfer TO ABENA MENSAH CHARGES" is a ₦50 fee, not a payment to Abena).
  if (/commission on nip|nip transfer charge|vat charge|valueaddedtax|value added tax|stamp dut|sms alert charge|^vatcharges|transfer levy|\bemtl\b/.test(desc.replace(/\s+/g, " "))) {
    return { category: "Fees", subcategory: undefined, merchantName: "Bank charges", counterparty: undefined, source: "rule", confidence: 0.95 };
  }
  // What the user taught about a PURPOSE ("rent and dd", "monthly") beats what they taught about a PERSON
  // ("Partner"): rent paid to your wife is still rent.
  const ordered = [...userRules].sort((a, b) => Number(isNamePattern(a.pattern)) - Number(isNamePattern(b.pattern)));
  for (const r of ordered) {
    if (!r.category) continue;
    // Names match only the other party (so "my name" never matches "FROM <me> TO <someone>");
    // merchant words and memo phrases match the narration text.
    const hit = isNamePattern(r.pattern)
      ? !!counterparty && sameName(counterparty, r.pattern)
      : desc.includes(r.pattern) || (counterparty?.toLowerCase() ?? "").includes(r.pattern);
    if (hit) {
      return {
        category: r.category,
        subcategory: r.subcategory ?? undefined,
        merchantName: r.canonicalName,
        counterparty,
        source: "user",
        confidence: 1,
      };
    }
  }

  // Wallet apps move money between the user's own currency wallets: "… debited from CAD wallet to fund GHS wallet".
  if (/debited from \w+ wallet to fund \w+ wallet|wallet to wallet|fund(ed)? (my )?\w+ wallet/.test(desc)) {
    return { category: OWN_TRANSFER, subcategory: "Between your wallets", merchantName: merchant, counterparty: undefined, source: "rule", confidence: 0.95 };
  }
  if (isSelf(counterparty, owners)) {
    return { category: OWN_TRANSFER, subcategory: "Between own accounts", merchantName: counterparty, counterparty, source: "rule", confidence: 0.9 };
  }

  for (const rule of RULES) {
    if (rule.only && rule.only !== input.type) continue;
    if (!rule.match.test(desc)) continue;
    // A debit to a person that mentions rent is housing; a credit mentioning rent is not.
    if (rule.category !== INCOME_CATEGORY && input.type === "CREDIT" && rule.category !== "Fees") continue;
    return {
      category: rule.category,
      subcategory: rule.subcategory,
      merchantName: rule.merchant ?? merchant ?? counterparty,
      counterparty,
      source: "rule",
      confidence: 0.9,
    };
  }

  if (input.type === "DEBIT" && counterparty) {
    const hint = nameHint(counterparty);
    if (hint) return { category: hint.category, subcategory: hint.subcategory, merchantName: merchant ?? counterparty, counterparty, source: "rule", confidence: hint.label === "A business" ? 0.55 : 0.75 };
  }
  if (input.type === "CREDIT" && counterparty && COMPANY.test(counterparty)) {
    // Money in from a company (employer, client, platform). The user can relabel it Salary once.
    return { category: INCOME_CATEGORY, subcategory: "Business income", merchantName: merchant ?? counterparty, counterparty, source: "rule", confidence: 0.7 };
  }
  if (input.type === "CREDIT") {
    const isTransfer = TRANSFER_MARKER.test(desc);
    return {
      category: INCOME_CATEGORY,
      subcategory: isTransfer ? "Transfer" : "Other income",
      merchantName: merchant ?? counterparty,
      counterparty,
      source: "default",
      confidence: isTransfer ? 0.6 : 0.4,
    };
  }
  if (TRANSFER_MARKER.test(desc) || counterparty) {
    return { category: "Transfers", merchantName: merchant ?? counterparty, counterparty, source: "default", confidence: 0.6 };
  }
  return { category: "Other", merchantName: merchant, counterparty, source: "default", confidence: 0.3 };
}
