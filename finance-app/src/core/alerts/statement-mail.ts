import { BANK_SOURCES } from "../sources";
import { senderDomain } from "./senders";

// Which emails carry a monthly statement (as opposed to a transaction alert).
// Sender domain plus a subject or filename pattern. Override or extend with STATEMENT_EMAIL_RULES
// (JSON array of { id, institution, senders, subject, filename }).

export interface StatementMailRule {
  id: string;
  institution: string;
  /** Domains, compared to the address after @. */
  senders: string[];
  /** Substrings, or /regex/flags, matched against the subject. */
  subject: string[];
  /** Substrings, or /regex/flags, matched against each attachment filename. */
  filename: string[];
}

/** Phrases the Gmail search must include so the alert-only GTBank query does not miss statements. */
export const STATEMENT_SEARCH_TERMS = ["statement", "e-statement", "account statement"] as const;

const BANK_PATTERNS = {
  subject: ["statement", "e-statement", "e statement", "account statement"],
  filename: ["statement", "e-statement", "estatement"],
};

const DEFAULT_RULES: StatementMailRule[] = [
  { id: "gtbank", institution: "GTBank", senders: ["gtbank.com", "gtco.com"], ...BANK_PATTERNS },
  { id: "firstbank", institution: "First Bank", senders: ["firstbanknigeria.com", "firstbank.com"], ...BANK_PATTERNS },
  { id: "sterling", institution: "Sterling Bank", senders: ["sterling.ng", "sterlingbankng.com"], ...BANK_PATTERNS },
  { id: "providus", institution: "Providus Bank", senders: ["providusbank.com"], ...BANK_PATTERNS },
  {
    id: "deel",
    institution: "Deel",
    senders: ["deel.com", "letsdeel.com"],
    subject: ["statement", "e-statement", "account statement", "transaction export", "transactions export"],
    filename: ["statement", "transactions", "deel"],
  },
  {
    id: "wallet",
    institution: "Pesa",
    senders: ["pesa.com", "usepesa.com", "getpesa.com"],
    subject: ["statement", "e-statement", "account statement", "wallet statement"],
    filename: ["statement", "wallet"],
  },
];

function isRule(v: unknown): v is StatementMailRule {
  if (!v || typeof v !== "object") return false;
  const r = v as StatementMailRule;
  return typeof r.id === "string" && r.id.length > 0
    && typeof r.institution === "string" && r.institution.length > 0
    && Array.isArray(r.senders) && r.senders.every((s) => typeof s === "string")
    && Array.isArray(r.subject) && r.subject.every((s) => typeof s === "string")
    && Array.isArray(r.filename) && r.filename.every((s) => typeof s === "string");
}

function extraRules(): StatementMailRule[] {
  const raw = process.env.STATEMENT_EMAIL_RULES?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRule);
  } catch {
    return [];
  }
}

function patternTest(text: string, pattern: string): boolean {
  const wrapped = pattern.match(/^\/(.+)\/([a-z]*)$/i);
  if (wrapped) {
    try {
      return new RegExp(wrapped[1], wrapped[2] || "i").test(text);
    } catch {
      return false;
    }
  }
  return text.toLowerCase().includes(pattern.toLowerCase());
}

/** Built-in banks, Deel, and the wallet provider, plus STATEMENT_EMAIL_RULES overrides. */
export function statementRules(): StatementMailRule[] {
  const walletSenders = (process.env.WALLET_STATEMENT_SENDERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  const walletName = process.env.WALLET_STATEMENT_INSTITUTION?.trim() || "Pesa";
  const rules = DEFAULT_RULES.map((rule) => {
    if (rule.id !== "wallet") return { ...rule, senders: [...rule.senders] };
    return {
      ...rule,
      institution: walletName,
      senders: [...new Set([...rule.senders, ...walletSenders])],
    };
  });
  for (const extra of extraRules()) {
    const idx = rules.findIndex((rule) => rule.id === extra.id || rule.institution.toLowerCase() === extra.institution.toLowerCase());
    if (idx >= 0) rules[idx] = extra;
    else rules.push(extra);
  }
  return rules;
}

export function statementInstitutions(): { id: string; institution: string }[] {
  return statementRules().map((rule) => ({ id: rule.id, institution: rule.institution }));
}

export function statementSenderDomains(): string[] {
  return [...new Set(statementRules().flatMap((rule) => rule.senders.map((s) => s.toLowerCase().replace(/^@/, ""))))];
}

export function detectStatementEmail(input: { from: string; subject?: string; filenames?: string[] }): { id: string; institution: string } | null {
  const domain = senderDomain(input.from || "");
  if (!domain || domain.includes(" ")) return null;
  const subject = input.subject ?? "";
  const filenames = input.filenames ?? [];
  for (const rule of statementRules()) {
    const senderOk = rule.senders.some((sender) => {
      const d = sender.toLowerCase().replace(/^@/, "");
      return domain === d || domain.endsWith(`.${d}`);
    });
    if (!senderOk) continue;
    const subjectOk = rule.subject.some((pattern) => patternTest(subject, pattern));
    const fileOk = filenames.some((name) => rule.filename.some((pattern) => patternTest(name, pattern)));
    if (subjectOk || fileOk) return { id: rule.id, institution: rule.institution };
  }
  return null;
}

/**
 * Gmail search for statement mail. Separate from the alert-only GTBank query so a subject like
 * "Your e-statement" is still fetched. GMAIL_QUERY_STATEMENTS replaces the whole query.
 */
export function statementGmailQuery(): string {
  const override = process.env.GMAIL_QUERY_STATEMENTS?.trim();
  if (override) return override;
  const from = statementSenderDomains().map((domain) => `from:${domain}`).join(" OR ");
  const terms = ["statement", '"e-statement"', '"e statement"', '"account statement"', "filename:pdf", "filename:csv", "filename:xlsx"];
  return `(${from}) (${terms.join(" OR ")})`;
}

/**
 * Queries passed to listMessageIds. IMAP and the fixture inbox ignore the string and already
 * search every statement sender, so they run once. Gmail runs the alert query and this one.
 */
export function emailSearchQueries(sourceKind: string): string[] {
  const alerts = BANK_SOURCES.map((bank) => bank.query);
  if (sourceKind === "imap" || sourceKind === "fixture") return alerts.slice(0, 1);
  const statement = statementGmailQuery();
  return alerts.includes(statement) ? alerts : [...alerts, statement];
}
