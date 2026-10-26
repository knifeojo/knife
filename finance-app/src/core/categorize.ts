import { mappingFor, matchPeople, type KnownPerson } from "./people-match";
import type { Classification, TransactionType } from "./types";

export const EXPENSE_CATEGORIES = [
  "Food", "Transport", "Housing", "Utilities", "Shopping", "Subscriptions", "Family", "Giving",
  "Debt", "Healthcare", "Travel", "Business", "Transfers", "Fees", "Other",
] as const;
/** Giving used to be a subcategory of Other. Rows and rules labelled Other with one of these move to Giving. */
export const LEGACY_GIVING_SUBCATEGORIES = ["Giving", "Tithe", "Offering", "Charity", "Donation", "Donations"];
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

/** Loan apps and lenders. A transfer TO one of them is a repayment; money FROM one is loan proceeds. */
const LENDERS: [RegExp, string][] = [
  [/\bfairmoney\b/, "FairMoney"],
  [/\brenmoney\b|\bremb\b/, "Renmoney"],
  [/\bpalm ?credit\b/, "PalmCredit"],
  [/\bcarbon\b|\bonefi\b|\bpaylater\b/, "Carbon"],
  [/\bbranch international\b|\bbranch\.co\b/, "Branch"],
  [/\baella ?credit\b/, "Aella"],
  [/\bquick ?check\b/, "QuickCheck"],
  [/\bokash\b/, "OKash"],
  [/\beasemoni\b/, "EaseMoni"],
  [/\blendigo\b/, "Lendigo"],
  [/\bspecta\b/, "Specta"],
  [/\bnewcredit\b/, "NewCredit"],
  [/\bsokoloan\b/, "SokoLoan"],
  [/\bzedvance\b/, "Zedvance"],
];
const LENDER_WORDS = new RegExp(LENDERS.map(([re]) => re.source).join("|"));

/**
 * Savings and investment apps, and banks' own lock-away products. Money sent there is still the
 * user's, so it is an own transfer (Savings), never spending. Bare "savings" is NOT here: it is also
 * an account type ("FROM EZE ADA SAVINGS TO KEMI").
 */
const SAVINGS = /piggy ?vest|piggybank|cowrywise|risevest|\brise vest\b|bamboo (?:invest|systems)|investbamboo|trove finance|\bchaka\b|\bladda\b|\bowealth\b|\bcashbox\b|alat goals?|target savings|fixed deposit|safe ?lock|savings (?:plan|goal)|money market fund|mutual fund/;
const SAVINGS_NAMES: [RegExp, string][] = [
  [/piggy ?vest|piggybank/, "PiggyVest"], [/cowrywise/, "Cowrywise"], [/risevest|rise vest/, "Risevest"], [/bamboo/, "Bamboo"],
  [/trove/, "Trove"], [/\bchaka\b/, "Chaka"], [/\bladda\b/, "Ladda"], [/owealth/, "OWealth"], [/cashbox/, "PalmPay CashBox"],
];

const BETTING = /bet9ja|sportybet|betking|1xbet|nairabet|merrybet|\bmsport\b|bangbet|betway|parimatch|accessbet|surebet|lottomania|baba ijebu|premier lotto|naijabet|betland/;

// Ordered: first match wins. Patterns run against the lowercased description.
const RULES: Rule[] = [
  // Income
  { match: /salary|payroll|\bsal\b/, category: INCOME_CATEGORY, subcategory: "Salary", only: "CREDIT" },
  { match: /upwork/, merchant: "Upwork", category: INCOME_CATEGORY, subcategory: "Consulting", only: "CREDIT" },
  { match: /deel|remote\.com|payoneer|fiverr|toptal/, category: INCOME_CATEGORY, subcategory: "Consulting", only: "CREDIT" },
  { match: /invoice|consult/, category: INCOME_CATEGORY, subcategory: "Consulting", only: "CREDIT" },
  { match: /refund|reversal|reversed|reimburs|\brvsl\b|\brev\//, category: INCOME_CATEGORY, subcategory: "Refund", only: "CREDIT" },
  { match: /interest capitali[sz]ed|interest run|int\.? ?pd|interest paid|credit interest/, merchant: "Interest", category: INCOME_CATEGORY, subcategory: "Interest", only: "CREDIT" },
  { match: /\bpesa\b(?!peer)| pesa payments/, merchant: "Pesa", category: INCOME_CATEGORY, subcategory: "Transfer", only: "CREDIT" },

  // Fees
  // PDFs sometimes glue words ("VATCHARGES", "TransferCHARGES"), so these avoid leading word boundaries.
  { match: /sms alert|alert charge|commission|stamp duty|\bvat|maintenance fee|card maint|\bcot\b|nip charge|transfer charge|charges?\b|transfer levy|\bemtl\b/, merchant: "Bank charges", category: "Fees" },

  // Cash. "cash withdrawal" must stay above the general withdrawal rule.
  { match: /\batm\b|cash wdl|cash withdrawal|\bwdl\b|pos (?:cash )?withdrawal|\bcash ?out\b/, merchant: "Cash withdrawal", category: "Other", subcategory: "Cash" },
  // Deel (and similar) withdrawals are money leaving a wallet for a bank, not uncategorized spend.
  { match: /\bwithdraw(?:al|als)?\b/, category: "Transfers", subcategory: "Withdrawal", only: "DEBIT" },

  // Betting wallets. Winnings paid back out are income; stakes are spending, never a transfer.
  { match: BETTING, category: INCOME_CATEGORY, subcategory: "Other income", only: "CREDIT" },
  { match: BETTING, category: "Other", subcategory: "Betting", only: "DEBIT" },

  // Food delivery first: "BOLT FOOD" is food, not a ride, and "JUMIA FOOD" is not shopping.
  { match: /bolt ?food/, merchant: "Bolt Food", category: "Food", subcategory: "Delivery" },
  { match: /jumia ?food/, merchant: "Jumia Food", category: "Food", subcategory: "Delivery" },
  { match: /uber ?eats/, merchant: "Uber Eats", category: "Food", subcategory: "Delivery" },
  { match: /chowdeck/, merchant: "Chowdeck", category: "Food", subcategory: "Delivery" },
  { match: /glovo/, merchant: "Glovo", category: "Food", subcategory: "Delivery" },
  { match: /heyfood|foodcourt/, category: "Food", subcategory: "Delivery" },

  // Transport
  { match: /\buber\b/, merchant: "Uber", category: "Transport", subcategory: "Ride hailing" },
  { match: /\bbolt\b|taxify/, merchant: "Bolt", category: "Transport", subcategory: "Ride hailing" },
  { match: /indrive/, merchant: "inDrive", category: "Transport", subcategory: "Ride hailing" },
  { match: /lagride|\brida\b|gokada|safeboda|\boride\b|max\.ng|\bmaxng\b/, category: "Transport", subcategory: "Ride hailing" },
  { match: /shuttlers|\blagbus\b|\bbrt\b|primero|cowry ?card|\bcowry\b(?!wise)|\bdanfo\b|\bkeke\b|\bokada\b|\bt ?fare\b|transport fare/, category: "Transport", subcategory: "Public transport" },
  { match: /abc transport|god is good motors|\bgig ?m\b|gig motors|guo transport|peace mass transit|chisco|young shall grow|libra motors/, category: "Transport", subcategory: "Interstate bus" },
  // Diesel for the generator powers the home, not a car.
  { match: /\b(?:gen|generator)\b.*\bdiesel\b|\bdiesel\b.*\b(?:gen|generator)\b/, category: "Housing", subcategory: "Generator & diesel" },
  { match: /total ?energies|\bmobil\b|oando|conoil|ardova|nnpc|mrs oil|\b11 ?plc\b|forte ?oil|nipco|rain ?oil|matrix energy|eterna|filling station|\bfuel\b|\bdiesel\b|\bpetrol\b|\bpms\b/, category: "Transport", subcategory: "Fuel" },
  { match: /\blcc\b|toll/, category: "Transport", subcategory: "Tolls" },
  { match: /\bparking\b|park ?fee/, category: "Transport", subcategory: "Parking" },

  // Fitness before subscriptions: a gym membership is health, not software.
  { match: /\bgym\b|i-?fitness|fitness|bodyline/, category: "Healthcare", subcategory: "Fitness" },

  // Subscriptions
  { match: /netflix/, merchant: "Netflix", category: "Subscriptions", subcategory: "Streaming" },
  { match: /spotify/, merchant: "Spotify", category: "Subscriptions", subcategory: "Streaming" },
  { match: /showmax/, merchant: "Showmax", category: "Subscriptions", subcategory: "Streaming" },
  { match: /youtube/, merchant: "YouTube", category: "Subscriptions", subcategory: "Streaming" },
  { match: /prime ?video|amazon prime/, merchant: "Prime Video", category: "Subscriptions", subcategory: "Streaming" },
  { match: /disney|boomplay|audiomack|deezer|apple music/, category: "Subscriptions", subcategory: "Streaming" },
  { match: /apple\.com|itunes|icloud/, merchant: "Apple", category: "Subscriptions" },
  { match: /openai|chatgpt/, merchant: "OpenAI", category: "Subscriptions", subcategory: "Software" },
  { match: /anthropic|claude\.ai/, merchant: "Anthropic", category: "Subscriptions", subcategory: "Software" },
  { match: /google \*|google\.com|gsuite|workspace/, merchant: "Google", category: "Subscriptions", subcategory: "Software" },
  { match: /canva|notion|figma|slack|zoom|microsoft|office ?365|adobe|github|dropbox|linkedin/, category: "Subscriptions", subcategory: "Software" },

  // Utilities (bills)
  { match: /\bdstv\b|\bgotv\b|multichoice/, merchant: "MultiChoice", category: "Utilities", subcategory: "TV" },
  { match: /startimes/, merchant: "StarTimes", category: "Utilities", subcategory: "TV" },
  { match: /ikeja electric|\bikedc\b|ekedc|eko electric|aedc|ibedc|\bphed\b|\beedc\b|kaedco|\bjed\b|\bbedc\b|\byedc\b|phcn|\bnepa\b|prepaid meter|electricity|buypower|power token|light bill/, category: "Utilities", subcategory: "Electricity" },
  { match: /spectranet|starlink|smile|fibre|internet|\bipnx\b|tizeti|wifi\.com|fiberone|swift ?networks/, category: "Utilities", subcategory: "Internet" },
  { match: /\bmtn\b|airtel|\bglo\b|9mobile|airtime|data bundle|data purchase|\bdata sub\b|\bvtu\b|recharge card/, category: "Utilities", subcategory: "Airtime & data" },
  { match: /lawma|\bwater\b|\bpsp\b|waste (?:bill|levy|collection)/, category: "Utilities" },
  { match: /vtpass|\bbaxi\b|irecharge|paybills|bills? payment/, category: "Utilities" },

  // Food and groceries
  { match: /shoprite/, merchant: "Shoprite", category: "Food", subcategory: "Groceries" },
  { match: /\bspar\b/, merchant: "Spar", category: "Food", subcategory: "Groceries" },
  { match: /ebeano|justrite|market square|hubmart|supermarket|foodco|sahad|grand square|addide|park ?n ?shop|farm ?city|mega ?plaza/, category: "Food", subcategory: "Groceries" },
  { match: /chicken republic|kfc|domino|cold stone|mr ?bigg|sweet sensation|kilimanjaro|the place|tantali[sz]ers|bukka hut|chopstix|debonairs|pizza ?hut|burger king|krispy kreme|yellow chilli|ofada boy|restaurant|cafe|eatery/, category: "Food", subcategory: "Eating out" },

  // Shopping
  { match: /jumia/, merchant: "Jumia", category: "Shopping" },
  { match: /konga/, merchant: "Konga", category: "Shopping" },
  { match: /\bjiji\b|payporte|mr ?price|\bzara\b|\bh&m\b|ikea|decathlon|game stores|miniso/, category: "Shopping" },
  { match: /amazon|aliexpress|temu|shein|\bebay\b|\betsy\b/, category: "Shopping", subcategory: "Online" },
  // Housing
  { match: /\brent\b|landlord|service charge|estate dues|agency fee|caution fee|estate levy|security levy/, category: "Housing", subcategory: "Rent" },

  // Healthcare
  { match: /pharmac|medplus|health ?plus|hospital|clinic|\bhmo\b|diagnostic|hygeia|reliance ?hmo|avon ?hmo|clina-?lancet|synlab|\bdental\b|optical/, category: "Healthcare" },

  // Travel
  { match: /air peace|arik|ibom air|united nigeria|overland airways|green africa|valuejet|max air|aero contractors|dana air|emirates|qatar airways|british airways|kenya airways|ethiopian airlines|rwandair|lufthansa|\bklm\b|turkish airlines|virgin atlantic|wakanow|travelstart|hotels\.ng|booking\.com|expedia|agoda|airbnb|hotel|\bvfs\b|visa fee|embassy/, category: "Travel" },

  // Debt. Lenders are loan apps the user is repaying, not wallets he holds. Credits from them are
  // loan proceeds (see lenderMerchant), not income.
  { match: new RegExp(`loan repay|credit card|${LENDER_WORDS.source}`), merchant: undefined, category: "Debt", subcategory: "Loan repayment" },

  // Family / education
  { match: /school fees|tuition|\bcreche\b|\bwaec\b|\bjamb\b|\bneco\b|pta levy|school bus|text ?books?/, category: "Family", subcategory: "Education" },

  // Giving: churches and mosques by name, then the memo words people type.
  { match: /\brccg\b|winners chapel|living faith|daystar|\bmfm\b|deeper life|salvation ministries|harvesters|house on the rock|koinonia|cathedral|\bparish\b/, category: "Giving", subcategory: "Church" },

  // Business
  { match: /\bcac\b|\bfirs\b|\blirs\b|tax payment|remita/, category: "Business", subcategory: "Tax & compliance" },

  // Memo keywords people type on transfers ("CLOTHES TO ...", "HAIR TO ...", "LOAN TO ...")
  { match: /\b(clothes|clothing|fashion|boutique|shoes?|tailor|fabric|aso ?ebi)\b/, category: "Shopping", subcategory: "Clothing" },
  { match: /\b(hair|salon|barb(er|ing)|spa|nails?|make ?up|lashes|pedicure|manicure)\b/, category: "Shopping", subcategory: "Personal care" },
  { match: /\b(cleaning|cleaner|laundry|dry ?clean|gardener|security|plumber|electrician|fumigation|generator|house ?help|nanny|maid|driver|gateman|steward|house ?boy|house ?girl)\b/, category: "Housing", subcategory: "Home services" },
  { match: /\b(tyres?|tires?|mechanic|vulcani[sz]er|car wash|car repair|spare parts?|autos?\b|panel beat)/, category: "Transport", subcategory: "Car" },
  { match: /\b(birthday|gift|wedding|condolence|baby shower|bday)\b/, category: "Family", subcategory: "Gifts" },
  { match: /\b(wife|hubby|husband)\b/, category: "Family", subcategory: "Partner" },
  { match: /\b(daddy|daddys|dad|father|mummy|mummys|mum|mom|mother|parents|upkeep|allowance|pocket money|feeding|aunty|auntie|uncle|grandma|granny|in ?laws?|kids|children)\b/, category: "Family", subcategory: "Family support" },
  { match: /\b(tithe|tithes|offering|church|mosque|zakat|sadaqah|donation|charity|seed|pledge)\b/, category: "Giving" },
  { match: /\b(drugs|medication|medicine|lab test|scan)\b/, category: "Healthcare" },
  { match: /\b(flight|air ?ticket)\b/, category: "Travel" },
  { match: /\b(food ?stuffs?|groceries|market|lunch|dinner|breakfast|food|suya|drinks|small chops|shawarma|meat|fish)\b/, category: "Food" },
  { match: /\bsubscriptions?\b/, category: "Subscriptions" },
  { match: /\b(loan|lend|borrow)\b/, category: "Debt", subcategory: "Loans" },
  { match: /\b(sq ?uad|squad|paystack|flutterwave|interswitch|opay merchant|monnify)\b/, category: "Shopping", subcategory: "Online payment" },
];

// Merchant normalization: noisy narrations -> one canonical name ("UBER *TRIP", "UBER BV" -> "Uber").
// Global aliases here; user corrections add user-scoped aliases in the merchant_aliases table.
const MERCHANT_ALIASES: [RegExp, string][] = [
  [/bolt ?food/, "Bolt Food"], [/uber ?eats/, "Uber Eats"], [/jumia ?food/, "Jumia Food"], [/heyfood/, "Heyfood"], [/foodcourt/, "FoodCourt"],
  [/\buber\b/, "Uber"], [/\bbolt\b|taxify/, "Bolt"], [/indrive/, "inDrive"], [/lagride/, "LagRide"], [/gokada/, "Gokada"], [/shuttlers/, "Shuttlers"],
  [/prime ?video|amazon prime/, "Prime Video"], [/startimes/, "StarTimes"], [/buypower/, "BuyPower"], [/health ?plus/, "HealthPlus"],
  [/bet9ja/, "Bet9ja"], [/sportybet/, "SportyBet"], [/betking/, "BetKing"], [/1xbet/, "1xBet"],
  ...LENDERS,
  ...SAVINGS_NAMES,
  [/total ?energies/, "TotalEnergies"], [/conoil/, "Conoil"], [/\bmobil\b/, "Mobil"], [/oando/, "Oando"], [/nnpc/, "NNPC"],
  [/cold stone/, "Cold Stone Creamery"], [/chicken republic/, "Chicken Republic"], [/\bkfc\b/, "KFC"], [/domino/, "Domino's"],
  [/the place/, "The Place"], [/kilimanjaro/, "Kilimanjaro"], [/chowdeck/, "Chowdeck"], [/glovo/, "Glovo"],
  [/shoprite/, "Shoprite"], [/\bspar\b/, "Spar"], [/ebeano/, "Ebeano"], [/justrite/, "Justrite"],
  [/netflix/, "Netflix"], [/spotify/, "Spotify"], [/showmax/, "Showmax"], [/openai|chatgpt/, "OpenAI"], [/anthropic|claude\.ai/, "Anthropic"],
  [/apple\.com|itunes|icloud/, "Apple"], [/\bdstv\b|\bgotv\b|multichoice/, "MultiChoice"],
  [/ikeja electric/, "Ikeja Electric"], [/ekedc|eko electric/, "Eko Electric"], [/spectranet/, "Spectranet"], [/starlink/, "Starlink"],
  [/\bmtn\b/, "MTN"], [/airtel/, "Airtel"], [/\bglo\b/, "Glo"],
  [/jumia/, "Jumia"], [/konga/, "Konga"], [/amazon/, "Amazon"], [/air peace/, "Air Peace"], [/ibom air/, "Ibom Air"],
  [/medplus/, "MedPlus"],
  [/upwork/, "Upwork"], [/payoneer/, "Payoneer"], [/\bpesa\b(?!peer)/, "Pesa"],
];

export function normalizeMerchant(description: string): string | undefined {
  const d = description.toLowerCase();
  return MERCHANT_ALIASES.find(([re]) => re.test(d))?.[1];
}

const TRANSFER_MARKER = /\b(trf|nip|fip|transfer|mob\/utu|ussd)\b|instant payment|outward|inward/;

/** Loan apps the user repays. A credit from one of these is disbursement, not salary or business income. */
export function lenderMerchant(desc: string): string | undefined {
  const d = desc.toLowerCase();
  return LENDERS.find(([re]) => re.test(d))?.[1];
}

/** The canonical lender names statement rows are labelled with, in detection order. */
export const LENDER_NAMES: readonly string[] = LENDERS.map(([, name]) => name);

/** "renmoney", "Remb" or "RENMONEY MFB" -> "Renmoney". undefined when it is not a known lender. */
export function canonicalLender(raw: string): string | undefined {
  const t = raw.trim();
  return LENDER_NAMES.find((n) => n.toLowerCase() === t.toLowerCase()) ?? lenderMerchant(t);
}

function savingsMerchant(desc: string): string | undefined {
  return SAVINGS_NAMES.find(([re]) => re.test(desc))?.[1];
}

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

const lettersOnly = (s: string) => s.replace(/[^A-Za-z ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * The other person's bank as written in a multi-part narration: "TO CARBON - JOHN SMITH",
 * "TO JOHN SMITH/CARBON" (debits) or "0001-JOHN SMITH-CARBON" (credits). Returned as written.
 */
function bankSegment(d: string, type: TransactionType): string | undefined {
  let text = d;
  if (type === "DEBIT") {
    const idx = d.search(/\bTO\s+/i);
    if (idx < 0) return undefined;
    text = d.slice(idx).replace(/^TO\s+/i, "");
  }
  const parts = text.split(type === "DEBIT" ? /\s+-\s+|\s*\/\s*/ : /\s*[-/]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  return parts.find((p) => BANK_CODE.test(lettersOnly(p.split(/\d|\bref\b/i)[0])));
}

// Card and POS narrations: "POS/WEB PMNT @ ABC STORES LEKKI LA NG" (GTBank), "POS PURCHASE: ABC STORES" (First Bank),
// "POS-Web Purchase-ABC STORES-LA-NG" (Sterling), "WEB PURCHASE ABC.COM".
const CARD_PURCHASE = /\b(?:pos|web)\b(?:[\s/-]*(?:web|purchase|purch|pmnt|pmt|payment|trans(?:action)?|txn|terminal)\b)*[\s@:-]*(?:at\s+)?(.+)$/i;
const PLACE_WORDS = /\b(la|lag|lagos|ng|nga|lang|abuja|abj|ph|kano|ibadan|ikeja|lekki|vi|ikoyi|yaba|surulere|ajah)\b.*$/i;

/** The shop on a card or POS payment, without the town and terminal codes. */
export function cardMerchant(description: string): string | undefined {
  const m = description.replace(/\s+/g, " ").match(CARD_PURCHASE);
  if (!m) return undefined;
  if (/\b(to|from|transfer|trf|nip|withdrawal)\b/i.test(m[1])) return undefined;
  const name = m[1].split(/\d|\/|\s+-\s+|-|\*/)[0];
  return cleanName(name.replace(PLACE_WORDS, "").trim() || name);
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
  [/interior|furnitur|wardrobe|carpent|cabinet|decor|curtain|upholster|tiles|paint/, { label: "Interior or furniture", category: "Housing", subcategory: "Home & furnishing" }],
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
  [/church|ministr|chapel|mosque|cathedral|parish|christian|gospel|fellowship/, { label: "Church or religious body", category: "Giving", subcategory: "Church" }],
  [/foundation|charity|ngo\b|trust fund/, { label: "Charity", category: "Giving", subcategory: "Charity" }],
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

export const COMPANY = /\b(ltd|limited|inc|plc|llc|corp|corporation|company|enterprises?|ventures|technologies|tech|services|global|group|holdings|nig(eria)?|payments?|solutions)\b/i;

export interface UserRule {
  pattern: string;
  canonicalName: string;
  category?: string | null;
  subcategory?: string | null;
  /** A person the owner told Ledger about. Matched on the other party's name, not on `pattern`. */
  person?: KnownPerson;
}

/** Key used to learn from user corrections: merchant name when known, else the counterparty, else cleaned narration. */
export function learningKey(description: string, merchantName?: string | null, counterparty?: string | null): string {
  if (merchantName) return merchantName.toLowerCase();
  if (counterparty) return counterparty.toLowerCase();
  return description.toLowerCase().replace(/[0-9]+/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The narration with a person's name words taken out, so a name like "Gift" is not read as a purpose. */
function withoutName(description: string, names: string[]): string {
  const words = [...new Set(names.flatMap((n) => n.toUpperCase().split(/[^A-Z]+/)).filter((w) => w.length >= 2))];
  if (!words.length) return description;
  return description.replace(new RegExp(`\\b(?:${words.map(escapeRe).join("|")})\\b`, "gi"), " ").replace(/\s+/g, " ").trim();
}

/**
 * Deterministic categorization. Only proposes merchant/category/subcategory; it never sees or
 * returns amount, date or reference, so it cannot alter them.
 *
 * Known people (rules with `person`) come after fees, own transfers, lenders and purpose words, and
 * before everything else: "TO OPAY - OJO GIFT A" is Family / Spouse once the owner said Gift is his wife,
 * but "SCHOOL FEES TO GIFT" is still Education. Only a confident, unambiguous name match applies.
 */
export function categorize(
  input: { description: string; type: TransactionType },
  userRules: UserRule[] = [],
  /** Account holder name(s), so transfers between the user's own accounts are not counted as income or spending. */
  owners: string[] = [],
): Classification {
  const people = userRules.flatMap((r) => (r.person ? [r.person] : []));
  if (!people.length) return categorizeRules(input, userRules, owners);
  const rules = userRules.filter((r) => !r.person);
  const full = categorizeRules(input, rules, owners);
  const match = matchPeople(full.counterparty, people);
  if (match.status !== "match") return full;
  const person = people.find((p) => p.id === match.personId)!;
  const personId = person.id;
  if (full.source === "rule" && ["Fees", "Debt", OWN_TRANSFER].includes(full.category)) return { ...full, personId };
  const names = [full.counterparty!, person.displayName, ...person.aliases.filter((a) => !a.rejected).map((a) => a.name)];
  const purpose = categorizeRules({ description: withoutName(input.description, names), type: input.type }, rules.filter((r) => !isNamePattern(r.pattern)), owners);
  const generic = purpose.category === "Transfers" || purpose.category === "Other" || (purpose.category === INCOME_CATEGORY && purpose.subcategory === "Transfer");
  if (purpose.source === "user" || (purpose.source === "rule" && purpose.confidence >= 0.9 && !generic)) {
    return { ...purpose, merchantName: purpose.merchantName ?? person.displayName, counterparty: full.counterparty, personId };
  }
  const label = mappingFor(person.relationship, input.type, { category: person.vendorCategory, subcategory: person.vendorSubcategory });
  if (!label) return { ...full, personId };
  return { category: label.category, subcategory: label.subcategory ?? undefined, merchantName: person.displayName, counterparty: full.counterparty, source: "user", confidence: 1, personId };
}

function categorizeRules(
  input: { description: string; type: TransactionType },
  userRules: UserRule[],
  owners: string[],
): Classification {
  const desc = input.description.toLowerCase();
  const collapsed = desc.replace(/\s+/g, " ");
  const rawCounterparty = extractCounterparty(input.description, input.type);
  // A recipient that is a known business gets its proper name ("Remb" -> "Renmoney").
  const counterparty = rawCounterparty ? (normalizeMerchant(rawCounterparty) ?? rawCounterparty) : undefined;

  // The other person's bank is where they keep money, not what the money was for: "TO MTN MOMO PSB - JOHN"
  // is not airtime, and "TO CARBON - JOHN SMITH" is a transfer to John, who banks with Carbon, not a loan
  // repayment. Lenders count as a bank only when someone else is named and nothing mentions repaying.
  const bank = bankSegment(input.description, input.type);
  const bankLender = bank ? lenderMerchant(bank) : undefined;
  const lenderIsOnlyTheirBank = !!bankLender && !!counterparty && !isSelf(counterparty, owners) && !lenderMerchant(counterparty)
    && !lenderMerchant(desc.replace(bank!.toLowerCase(), " ")) && !/repay|disburs/.test(desc);
  const ignoreBank = !!bank && !!counterparty && !SAVINGS.test(bank.toLowerCase()) && (!bankLender || lenderIsOnlyTheirBank);
  // Text the merchant and category rules read: the narration without the recipient's bank.
  const ruleDesc = ignoreBank ? desc.replace(bank!.toLowerCase(), " ") : desc;
  const merchant = normalizeMerchant(ruleDesc);
  const card = input.type === "DEBIT" ? cardMerchant(input.description) : undefined;

  // "REVERSED : Commission on NIP TransferCHARGES" is the bank giving a fee back. It stays in Fees
  // so it nets against fee spend, and it is a credit — not another fee debit and not income.
  const feeReversal = /\b(?:reversed|reversal|rvsl)\b|\brev\//.test(collapsed)
    && /commission|stamp dut|sms alert|alert charge|\bvat|vatcharges|valueaddedtax|value added tax|charges?\b|nip charge|transfer levy|\bemtl\b|maintenance fee|transfer charge/.test(collapsed);
  if (input.type === "CREDIT" && feeReversal) {
    return { category: "Fees", subcategory: "Refund", merchantName: "Bank charges", counterparty: undefined, source: "rule", confidence: 0.95 };
  }
  // Bank charges are always fees, even when they name the person the transfer went to
  // ("Commission on NIP Transfer TO ABENA MENSAH CHARGES" is a ₦50 fee, not a payment to Abena).
  if (/commission on nip|nip transfer charge|vat charge|valueaddedtax|value added tax|stamp dut|sms alert charge|^vatcharges|transfer levy|\bemtl\b/.test(collapsed)) {
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

  // Wallet apps move money between the user's own currency wallets: "… debited from CAD wallet to fund GBP wallet".
  // A Deel card withdrawal is the same kind of move, onto the user's own card.
  if (/debited from \w+ wallet to fund \w+ wallet|wallet to wallet|fund(ed)? (my )?\w+ wallet|deel card withdrawal/.test(desc)) {
    return { category: OWN_TRANSFER, subcategory: "Between your wallets", merchantName: merchant, counterparty: undefined, source: "rule", confidence: 0.95 };
  }
  // Lenders collect repayments into accounts named after the borrower ("TO FAIRMONEY MFB - <you>").
  // That is a loan repayment, not a move between the user's own accounts.
  const lender = lenderMerchant(ruleDesc);
  if (lender && input.type === "DEBIT" && isSelf(counterparty, owners)) {
    return { category: "Debt", subcategory: "Loan repayment", merchantName: lender, counterparty: lender, source: "rule", confidence: 0.9 };
  }
  // Savings apps hold the user's own money, whoever the deposit account is named after ("TO PIGGYVEST SAVINGS").
  // A credit that says interest is left to the interest rule, because interest is income.
  if (SAVINGS.test(desc) && !(input.type === "CREDIT" && /interest/.test(desc))) {
    const app = savingsMerchant(desc);
    return { category: OWN_TRANSFER, subcategory: "Savings", merchantName: app ?? counterparty, counterparty, source: "rule", confidence: 0.85 };
  }
  if (isSelf(counterparty, owners)) {
    return { category: OWN_TRANSFER, subcategory: "Between own accounts", merchantName: counterparty, counterparty, source: "rule", confidence: 0.9 };
  }

  // Lender disbursements are loan proceeds, not income. Repayments stay on the debt rule below.
  if (lender && input.type === "CREDIT") {
    return { category: "Debt", subcategory: "Loan proceeds", merchantName: lender, counterparty: lender, source: "rule", confidence: 0.9 };
  }
  // Deel earned-wage advances: the advance is a loan in, the fee is an expense, repayment goes out.
  if (/\bdeel advance fee\b/.test(desc)) {
    return { category: "Fees", subcategory: "Advance fee", merchantName: "Deel", counterparty, source: "rule", confidence: 0.95 };
  }
  if (/\bdeel advance repayment\b/.test(desc)) {
    return { category: "Debt", subcategory: "Loan repayment", merchantName: "Deel", counterparty, source: "rule", confidence: 0.95 };
  }
  if (input.type === "CREDIT" && /\bdeel advance\b/.test(desc)) {
    return { category: "Debt", subcategory: "Loan proceeds", merchantName: "Deel", counterparty, source: "rule", confidence: 0.95 };
  }

  for (const rule of RULES) {
    if (rule.only && rule.only !== input.type) continue;
    if (!rule.match.test(ruleDesc)) continue;
    // A debit to a person that mentions rent is housing; a credit mentioning rent is not.
    if (rule.category !== INCOME_CATEGORY && input.type === "CREDIT" && rule.category !== "Fees") continue;
    return {
      category: rule.category,
      subcategory: rule.subcategory,
      merchantName: rule.merchant ?? merchant ?? counterparty ?? card,
      counterparty,
      source: "rule",
      confidence: 0.9,
    };
  }

  // A card payment at a shop no rule knows: the shop's name may still say what it sells. If it does not,
  // it is still a purchase (not a transfer), filed under Shopping and flagged for review.
  if (card) {
    const hint = nameHint(card);
    const name = normalizeMerchant(card) ?? card;
    if (hint) return { category: hint.category, subcategory: hint.subcategory, merchantName: name, counterparty, source: "rule", confidence: hint.label === "A business" ? 0.55 : 0.75 };
    return { category: "Shopping", subcategory: "Card purchase", merchantName: name, counterparty, source: "default", confidence: 0.45 };
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
