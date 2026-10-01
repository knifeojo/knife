import { db } from "@/lib/db";
import { ingestTransaction } from "./ledger";
import type { CanonicalTransaction, TransactionType } from "./types";

// Realistic, clearly-labelled DEMO data for a Lagos-based professional. Goes through the same
// ingestTransaction pipeline as real alerts, so dedup and categorization are exercised too.

interface Template {
  day: number;
  type: TransactionType;
  naira: number;
  desc: string;
  /** Skip in these month offsets (0 = current month) to make data less uniform */
  skip?: number[];
  jitter?: number;
}

const MONTHLY: Template[] = [
  { day: 25, type: "CREDIT", naira: 3_750_000, desc: "NIP/ACME TECHNOLOGIES LTD/SALARY" },
  { day: 12, type: "CREDIT", naira: 1_983_611, desc: "NIP/PESA PAYMENTS LTD/CONSULTING INVOICE", skip: [0, 2, 4] },
  { day: 18, type: "CREDIT", naira: 666_800, desc: "SWIFT INWARD/UPWORK ESCROW INC CONVERTED", skip: [1, 3, 5], jitter: 0.1 },
  { day: 1, type: "DEBIT", naira: 250_000, desc: "TRF/RENT/FRM DEMO USER TO OLUWASEUN ADEYEMI" },
  { day: 3, type: "DEBIT", naira: 150_000, desc: "TRF/UPKEEP/FRM DEMO USER TO MAMA DEMO" },
  { day: 5, type: "DEBIT", naira: 7_000, desc: "WEB PURCHASE NETFLIX.COM LOS GATOS" },
  { day: 6, type: "DEBIT", naira: 1_700, desc: "WEB PURCHASE SPOTIFY P2A1B LAGOS" },
  { day: 8, type: "DEBIT", naira: 37_000, desc: "WEB PURCHASE DSTV SUBSCRIPTION MULTICHOICE" },
  { day: 9, type: "DEBIT", naira: 32_000, desc: "WEB OPENAI *CHATGPT SUBSCR" },
  { day: 10, type: "DEBIT", naira: 45_000, desc: "IKEJA ELECTRIC PREPAID METER TOKEN", jitter: 0.2 },
  { day: 11, type: "DEBIT", naira: 25_000, desc: "SPECTRANET INTERNET RENEWAL" },
  { day: 14, type: "DEBIT", naira: 120_000, desc: "POS PURCHASE SHOPRITE LEKKI LAGOS", jitter: 0.35 },
  { day: 21, type: "DEBIT", naira: 64_000, desc: "POS PURCHASE SPAR ADMIRALTY LAGOS", jitter: 0.4 },
  { day: 2, type: "DEBIT", naira: 18_500, desc: "WEB CHOWDECK TECHNOLOGIES LAGOS", jitter: 0.5 },
  { day: 16, type: "DEBIT", naira: 22_000, desc: "WEB CHOWDECK TECHNOLOGIES LAGOS", jitter: 0.5 },
  { day: 4, type: "DEBIT", naira: 14_200, desc: "UBER *TRIP HELP.UBER.COM", jitter: 0.5 },
  { day: 13, type: "DEBIT", naira: 9_800, desc: "POS/BOLT TECHNOLOGY OU/LAGOS NG", jitter: 0.5 },
  { day: 19, type: "DEBIT", naira: 11_300, desc: "UBER BV TRIP", jitter: 0.5 },
  { day: 23, type: "DEBIT", naira: 30_000, desc: "TOTALENERGIES FILLING STATION LEKKI", jitter: 0.3 },
  { day: 7, type: "DEBIT", naira: 10_000, desc: "MTN AIRTIME VTU PURCHASE" },
  { day: 17, type: "DEBIT", naira: 85_000, desc: "WEB JUMIA NIGERIA ORDER", skip: [0, 2], jitter: 0.6 },
  { day: 22, type: "DEBIT", naira: 48_000, desc: "POS COLD STONE CREAMERY VI", skip: [1], jitter: 0.4 },
  { day: 26, type: "DEBIT", naira: 35_000, desc: "MEDPLUS PHARMACY LEKKI", skip: [0, 1, 3] },
  { day: 15, type: "DEBIT", naira: 180_000, desc: "CARBON LOAN REPAYMENT DEBIT" },
  { day: 20, type: "DEBIT", naira: 90_000, desc: "TRF/STAFF SALARY/FRM DEMO USER TO BLESSING OKON" },
  { day: 24, type: "DEBIT", naira: 60_000, desc: "POS CONOIL DIESEL FILLING STATION", jitter: 0.3 },
  { day: 12, type: "DEBIT", naira: 45_000, desc: "POS THE PLACE RESTAURANT LEKKI", jitter: 0.5 },
  { day: 25, type: "DEBIT", naira: 2_500_000, desc: "TRF/SAVINGS/FRM DEMO USER TO DEMO USER PIGGYVEST" },
  { day: 28, type: "DEBIT", naira: 52.5, desc: "SMS ALERT CHARGES" },
  { day: 28, type: "DEBIT", naira: 50, desc: "ELECTRONIC MONEY TRANSFER LEVY STAMP DUTY" },
];

const ONE_OFFS: { monthOffset: number; t: Template }[] = [
  { monthOffset: -1, t: { day: 9, type: "DEBIT", naira: 780_000, desc: "WEB AIR PEACE LTD BOOKING LOS-ABV" } },
  { monthOffset: -2, t: { day: 15, type: "DEBIT", naira: 350_000, desc: "TRF/SCHOOL FEES/FRM DEMO USER TO GREENFIELD ACADEMY" } },
  { monthOffset: 0, t: { day: 6, type: "CREDIT", naira: 45_250.5, desc: "REVERSAL/POS PURCHASE SHOPRITE LEKKI" } },
  { monthOffset: -3, t: { day: 20, type: "DEBIT", naira: 1_200_000, desc: "TRF/CAR REPAIRS/FRM DEMO USER TO AUTOFIX GARAGE" } },
];

// Deterministic pseudo random so every demo looks the same.
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

export function buildDemoTransactions(now: Date, months = 6): CanonicalTransaction[] {
  const rand = rng(42);
  const lagosNow = new Date(now.getTime() + 3600_000);
  const out: Omit<CanonicalTransaction, "balanceAfterMinor">[] = [];
  const push = (offset: number, t: Template, i: number) => {
    const y = lagosNow.getUTCFullYear();
    const m = lagosNow.getUTCMonth() + offset;
    const date = new Date(Date.UTC(y, m, t.day, 9 + Math.floor(rand() * 10), Math.floor(rand() * 60)) - 3600_000);
    if (date > now) return;
    const factor = t.jitter ? 1 - t.jitter / 2 + rand() * t.jitter : 1;
    const minor = BigInt(Math.round(t.naira * factor * 100));
    out.push({
      institution: "GTBank",
      source: "demo",
      sourceTransactionId: `demo-${offset}-${i}`,
      type: t.type,
      amountMinor: minor,
      currency: "NGN",
      transactionDate: date,
      description: t.desc,
      reference: `DEMO${String(Math.abs(offset)).padStart(2, "0")}${String(i).padStart(3, "0")}`,
      accountLast4: "4521",
      confidence: 1,
    });
  };
  for (let offset = -(months - 1); offset <= 0; offset++) {
    MONTHLY.forEach((t, i) => {
      if (t.skip?.includes(-offset)) return;
      push(offset, t, i);
    });
  }
  ONE_OFFS.forEach(({ monthOffset, t }, i) => push(monthOffset, t, 900 + i));

  // Running balance so balance-after is internally consistent. Opens at ₦1M.
  out.sort((a, b) => a.transactionDate.getTime() - b.transactionDate.getTime());
  let balance = 100_000_000n;
  return out.map((t) => {
    balance += t.type === "CREDIT" ? t.amountMinor : -t.amountMinor;
    return { ...t, balanceAfterMinor: balance };
  });
}

export async function seedDemoUser(userId: string, now = new Date()) {
  await db.financialConnection.upsert({
    where: { userId_provider: { userId, provider: "demo" } },
    update: { lastSyncedAt: now },
    create: { userId, provider: "demo", providerAccountId: "DEMO DATA", lastSyncedAt: now },
  });
  const txs = buildDemoTransactions(now);
  for (const t of txs) await ingestTransaction(userId, t, []);
  // A user correction so "learned" classifications are visible in the demo.
  const piggy = await db.transaction.findMany({ where: { userId, description: { contains: "PIGGYVEST" } } });
  if (piggy.length) {
    await db.transaction.updateMany({
      where: { userId, description: { contains: "PIGGYVEST" } },
      data: { category: "Own transfer", subcategory: "Savings", classificationSource: "user", classificationConfidence: 1 },
    });
  }
  return txs.length;
}
