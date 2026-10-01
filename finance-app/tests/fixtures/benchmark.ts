// Synthetic but realistic Nigerian bank narrations with the category a careful human would choose.
// Used to measure categorizer accuracy over time. Hard cases are included on purpose.
import type { TransactionType } from "@/core/types";

export interface BenchCase { description: string; type: TransactionType; expected: string }

export const OWNER = "EZE ADA BELLO";

export const BENCHMARK: BenchCase[] = [
  // Clear rule cases
  { description: "POS PURCHASE SHOPRITE LEKKI LAGOS", type: "DEBIT", expected: "Food" },
  { description: "WEB PURCHASE NETFLIX.COM LOS GATOS", type: "DEBIT", expected: "Subscriptions" },
  { description: "UBER *TRIP HELP.UBER.COM", type: "DEBIT", expected: "Transport" },
  { description: "SMS ALERT CHARGES SEP 2026", type: "DEBIT", expected: "Fees" },
  { description: "VATCHARGES", type: "DEBIT", expected: "Fees" },
  { description: "Stamp Duties STAMP DUTY CHARGE FOR TRXNS BTW 13-09-2026 TO 19-09-2026", type: "DEBIT", expected: "Fees" },
  { description: "Airtime Purchase VIA AIRTIME VIA GTWORLD 101CT-DATA FROM EZE ADA BELLO", type: "DEBIT", expected: "Utilities" },
  { description: "IKEJA ELECTRIC PREPAID METER TOKEN", type: "DEBIT", expected: "Utilities" },
  { description: "RENT AND DD FROM EZE ADA BELLO TO MENSAH ABENA AKOSUA", type: "DEBIT", expected: "Housing" },
  { description: "NIP/ACME TECHNOLOGIES LTD/SALARY SEPTEMBER 2026", type: "CREDIT", expected: "Income" },
  { description: "INTEREST CAPITALISED 0008853557:Int.Pd:01-09-2026 to 30-09-2026 Interest run", type: "CREDIT", expected: "Income" },
  // Memo and name hints
  { description: "Instant Payment Outward 0901 CLOTHES TO MONIEMFB - BE AWESOME FASHION COMPANY LIMITED", type: "DEBIT", expected: "Shopping" },
  { description: "Instant Payment Outward 0902 HAIR TO ZBN - EKANATURALS LIMITED", type: "DEBIT", expected: "Shopping" },
  { description: "Instant Payment Outward 0903 AGBADA TO OPAY - J'STITCHES COUTURE", type: "DEBIT", expected: "Shopping" },
  { description: "Instant Payment Outward 0904 TIRE TO OPAY - FEMI DEMOLA EZEKIEL", type: "DEBIT", expected: "Transport" },
  { description: "Instant Payment Outward 0905 CLEANING TO AELLA - IDONGESIT UMOREN", type: "DEBIT", expected: "Housing" },
  { description: "Instant Payment Outward 0906 HAPPY BIRTHDAY TO STERLING - OLUWATOBI DANIEL EZE", type: "DEBIT", expected: "Family" },
  { description: "OFFERING FROM EZE ADA BELLO TO GRACE CHRISTIAN WORLD ASSEMBLY", type: "DEBIT", expected: "Other" },
  { description: "Instant Payment Outward 0907 DELIS CAFE TO", type: "DEBIT", expected: "Food" },
  { description: "Instant Payment Outward 0908 FUEL TO PALMPAY", type: "DEBIT", expected: "Transport" },
  { description: "Instant Payment Outward 0909 LOAN TO REMB -", type: "DEBIT", expected: "Debt" },
  { description: "Instant Payment Outward 0910 PAYMENT TO ZBN - EBUBECHUKWUINTERIOR", type: "DEBIT", expected: "Housing" },
  { description: "Instant Payment Outward 0911 DRINKS TO GTB - LIVE LOUNGE LIMITED", type: "DEBIT", expected: "Food" },
  { description: "Instant Payment Outward 0912 X TO ZBN - FOUANI-SURULERE SHOWROOM", type: "DEBIT", expected: "Shopping" },
  // Own accounts
  { description: "Instant Payment Outward 0913 SUBSCRIPTIONS TO STERLING - ADA BELLO EZE", type: "DEBIT", expected: "Own transfer" },
  { description: "TRANSFER FROM EZE ADA BELLO", type: "CREDIT", expected: "Own transfer" },
  // Income sources
  { description: "W5WM-MONIE MFB-DEEL INC", type: "CREDIT", expected: "Income" },
  { description: "TRANSFER BETWEEN CUSTOMERS 0001-ADA BELLO EZE-110059-PESAPEER LTD .", type: "CREDIT", expected: "Income" },
  { description: "REVERSAL/POS PURCHASE SHOPRITE LEKKI", type: "CREDIT", expected: "Income" },
  // Hard: need context or common sense the rules don't have
  { description: "Instant Payment Outward 0914 SCHOOL FEES 1ST TERM TO FCMB - GREENSPRINGS SCHOOL", type: "DEBIT", expected: "Family" },
  { description: "Instant Payment Outward 0915 DSTV COMPACT TO GTB - MULTICHOICE NIGERIA", type: "DEBIT", expected: "Utilities" },
  { description: "Instant Payment Outward 0916 GENERATOR SERVICING TO OPAY - MUSA IBRAHIM", type: "DEBIT", expected: "Housing" },
  { description: "Instant Payment Outward 0917 MAMA UPKEEP TO KUDA - FUNMI EZE", type: "DEBIT", expected: "Family" },
  { description: "Instant Payment Outward 0918 DRIVER SALARY TO OPAY - SUNDAY OKON", type: "DEBIT", expected: "Housing" },
  { description: "Instant Payment Outward 0919 GROCERIES TO MONIEMFB - MAMA NKECHI PROVISIONS", type: "DEBIT", expected: "Food" },
  { description: "Instant Payment Outward 0920 DRUGS TO OPAY - HEALTHPLUS PHARMACY", type: "DEBIT", expected: "Healthcare" },
  { description: "Instant Payment Outward 0921 FLIGHT ABJ TO ZBN - AIR PEACE LIMITED", type: "DEBIT", expected: "Travel" },
  { description: "Instant Payment Outward 0922 GYM SUBSCRIPTION TO GTB - I-FITNESS", type: "DEBIT", expected: "Healthcare" },
  { description: "Instant Payment Outward 0923 LAGOS TOLL TO OPAY - LEKKI CONCESSION COMPANY", type: "DEBIT", expected: "Transport" },
  { description: "Instant Payment Outward 0924 SUYA AND DRINKS TO PALMPAY - MALLAM AUDU", type: "DEBIT", expected: "Food" },
];
