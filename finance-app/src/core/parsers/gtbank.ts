import { normalizeCurrency, parseAmountToMinor } from "@/lib/money";
import type { BankAlertParser, EmailMessage, ParsedTransaction, TransactionType } from "../types";
import { emailBodyText, extractFields, parseBankDate, pickField } from "./text";

// Field labels seen across GTBank alert layouts. Adding a new label is a one-line change.
const LABELS = {
  amount: ["amount", "transaction amount", "amt", "amount (ngn)"],
  type: ["transaction type", "txn type", "type", "dr/cr"],
  description: ["description", "narration", "narrative", "details", "transaction details"],
  remarks: ["remarks", "remark"],
  date: ["value date", "transaction date", "txn date", "date of transaction", "posting date", "date"],
  time: ["time of transaction", "transaction time", "time"],
  reference: ["reference", "reference number", "reference no", "ref", "ref no", "transaction reference", "document number", "session id"],
  availableBalance: ["available balance", "available bal", "avail bal", "avail. bal"],
  balance: ["current balance", "cleared balance", "balance", "ledger balance"],
  account: ["account number", "account no", "acct no", "account", "acct"],
};

const MONEY_RE = /(NGN|USD|GBP|EUR|₦|\$|£|€)?\s*([\d,]+(?:\.\d{1,2})?)\s*(NGN|USD|GBP|EUR)?/i;

function parseMoney(raw: string | undefined): { minor: bigint; currency?: string; drcr?: TransactionType } | undefined {
  if (!raw) return undefined;
  const m = raw.match(MONEY_RE);
  if (!m) return undefined;
  const minor = parseAmountToMinor(m[2]);
  if (minor === null) return undefined;
  const drcr = /\bDR\b/i.test(raw) ? "DEBIT" : /\bCR\b/i.test(raw) ? "CREDIT" : undefined;
  return { minor, currency: normalizeCurrency(m[1] ?? m[3]), drcr };
}

function detectType(fieldType: string | undefined, body: string, subject: string): TransactionType | undefined {
  const t = fieldType?.toLowerCase();
  if (t) {
    if (/debit|^dr$/.test(t)) return "DEBIT";
    if (/credit|^cr$/.test(t)) return "CREDIT";
  }
  if (/\b(has been|was)\s+debited\b|\bdebit transaction occurred\b/i.test(body)) return "DEBIT";
  if (/\b(has been|was)\s+credited\b|\bcredit transaction occurred\b/i.test(body)) return "CREDIT";
  if (/\bdebit\b/i.test(subject) && !/\bcredit\b/i.test(subject)) return "DEBIT";
  if (/\bcredit\b/i.test(subject) && !/\bdebit\b/i.test(subject)) return "CREDIT";
  return undefined;
}

function last4(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^0-9]/g, "");
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

export class GTBankParser implements BankAlertParser {
  readonly name = "GTBankParser";
  readonly institution = "GTBank";

  canParse(email: EmailMessage): boolean {
    const body = emailBodyText(email);
    const sender = email.from.toLowerCase();
    const mentionsBank = /gtbank|guaranty trust|\bgens\b/i.test(body) || /gtbank|gtco/.test(sender);
    if (!mentionsBank) return false;
    // Alerts either say so or carry a direction plus an amount; newsletters do neither.
    // Alert-shaped emails that then fail to parse are reported as parse failures, not skipped.
    const text = `${email.subject}\n${body}`;
    const looksLikeAlert =
      /transaction alert|transaction notification|transaction occurred/i.test(text) ||
      (/(debit|credit|debited|credited)/i.test(text) && MONEY_RE.test(body));
    if (!looksLikeAlert) return false;
    let score = 0;
    if (/gtbank|gtco/.test(sender)) score += 2;
    if (/gens|transaction alert|debit|credit/i.test(email.subject)) score += 1;
    if (/guaranty trust|gtbank|\bgens\b/i.test(body)) score += 1;
    if (/(debit|credit|debited|credited)/i.test(body) && MONEY_RE.test(body)) score += 1;
    return score >= 3;
  }

  parse(email: EmailMessage): ParsedTransaction | null {
    const body = emailBodyText(email);
    const fields = extractFields(body);

    // Amount: labelled field first, then the prose form "debited with NGN 250,000.00", then the subject.
    let money = parseMoney(pickField(fields, LABELS.amount));
    if (!money) {
      const prose = body.match(/(?:debited|credited)\s+(?:with|by|for)\s+((?:NGN|USD|GBP|EUR|₦|\$|£|€)\s*[\d,]+(?:\.\d{1,2})?)/i);
      money = parseMoney(prose?.[1]);
    }
    if (!money) {
      const subj = email.subject.match(/(?:debit|credit)[^\d]{0,12}((?:NGN|USD|₦)\s*[\d,]+(?:\.\d{1,2})?)/i);
      money = parseMoney(subj?.[1]);
    }
    if (!money || money.minor <= 0n) return null;

    const typeField = pickField(fields, LABELS.type);
    const type = detectType(typeField, body, email.subject) ?? money.drcr;
    // Never guess direction. An alert we cannot classify as debit or credit is a parse failure.
    if (!type) return null;

    const dateField = pickField(fields, LABELS.date);
    const parsedDate = parseBankDate(dateField, pickField(fields, LABELS.time));
    const transactionDate = parsedDate ?? email.date;

    const description =
      pickField(fields, LABELS.description) ??
      pickField(fields, LABELS.remarks) ??
      `GTBank ${type === "DEBIT" ? "debit" : "credit"}`;
    const remarks = pickField(fields, LABELS.remarks);
    const fullDescription =
      remarks && remarks !== description && !description.includes(remarks) ? `${description} / ${remarks}` : description;

    const reference = pickField(fields, LABELS.reference)?.replace(/\s+/g, "");
    const balance = parseMoney(pickField(fields, LABELS.availableBalance) ?? pickField(fields, LABELS.balance));
    const accountLast4 = last4(pickField(fields, LABELS.account));

    // Amount and direction are guaranteed at this point; score the optional fields.
    const found = [true, true, !!parsedDate,!!pickField(fields, LABELS.description), !!reference, !!balance, !!accountLast4];
    const confidence = Math.round((found.filter(Boolean).length / found.length) * 100) / 100;

    return {
      institution: this.institution,
      type,
      amountMinor: money.minor,
      currency: money.currency ?? balance?.currency ?? "NGN",
      transactionDate,
      description: fullDescription.slice(0, 280),
      reference: reference || undefined,
      balanceAfterMinor: balance?.minor,
      accountLast4,
      confidence,
    };
  }
}
