import { afterEach, describe, expect, it } from "vitest";
import { BANK_SOURCES } from "@/core/sources";
import {
  STATEMENT_SEARCH_TERMS,
  detectStatementEmail,
  emailSearchQueries,
  statementGmailQuery,
  statementRules,
} from "@/core/alerts/statement-mail";

const ENV_KEYS = ["STATEMENT_EMAIL_RULES", "GMAIL_QUERY_STATEMENTS", "WALLET_STATEMENT_SENDERS", "WALLET_STATEMENT_INSTITUTION"] as const;
const previous: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

function rememberEnv() {
  for (const key of ENV_KEYS) previous[key] = process.env[key];
}

describe("statement email detection", () => {
  it("matches each bank, Deel and the wallet provider, and ignores alert-only mail", () => {
    const cases: [string, string, string[] | undefined, string][] = [
      ["Statements <statements@gtbank.com>", "Your e-statement for September", ["september.pdf"], "GTBank"],
      ["estatement@gtco.com", "Account statement", undefined, "GTBank"],
      ["alerts@firstbanknigeria.com", "E-Statement", ["FirstBank.pdf"], "First Bank"],
      ["noreply@firstbank.com", "hello", ["account-statement.csv"], "First Bank"],
      ["mail@sterling.ng", "Your account statement", undefined, "Sterling Bank"],
      ["info@sterlingbankng.com", "Monthly", ["e-statement.pdf"], "Sterling Bank"],
      ["notify@providusbank.com", "Account statement", undefined, "Providus Bank"],
      ["receipts@deel.com", "Your transactions export", ["transactions.csv"], "Deel"],
      ["hello@letsdeel.com", "Statement", undefined, "Deel"],
      ["statements@pesa.com", "Wallet statement", ["wallet.pdf"], "Pesa"],
      ["ops@getpesa.com", "hello", ["statement.csv"], "Pesa"],
    ];
    for (const [from, subject, filenames, institution] of cases) {
      expect(detectStatementEmail({ from, subject, filenames })?.institution, subject).toBe(institution);
    }
    expect(detectStatementEmail({ from: "GeNS <gens@gtbank.com>", subject: "GeNS Transaction Alert [Debit]", filenames: [] })).toBeNull();
    expect(detectStatementEmail({ from: "friend@example.com", subject: "Your e-statement", filenames: ["statement.pdf"] })).toBeNull();
    expect(detectStatementEmail({ from: "news@gtbank.com", subject: "Introducing the new GTWorld app" })).toBeNull();
  });

  it("broadens Gmail search beyond the alert-only GTBank query and stays configurable", () => {
    rememberEnv();
    const alert = BANK_SOURCES[0].query;
    const statement = statementGmailQuery();
    for (const term of STATEMENT_SEARCH_TERMS) expect(statement.toLowerCase()).toContain(term);
    expect(statement).toContain("filename:pdf");
    expect(alert.toLowerCase()).not.toContain("e-statement");
    expect(emailSearchQueries("gmail")).toEqual([alert, statement]);
    expect(emailSearchQueries("imap")).toEqual([alert]);
    expect(emailSearchQueries("fixture")).toEqual([alert]);

    process.env.GMAIL_QUERY_STATEMENTS = "from:gtbank.com subject:custom-statement";
    expect(statementGmailQuery()).toBe("from:gtbank.com subject:custom-statement");

    process.env.STATEMENT_EMAIL_RULES = JSON.stringify([
      { id: "wallet", institution: "Ada Wallet", senders: ["adawallet.test"], subject: ["statement"], filename: ["statement"] },
    ]);
    process.env.WALLET_STATEMENT_SENDERS = "extra-wallet.test";
    expect(detectStatementEmail({ from: "ops@adawallet.test", subject: "Your statement" })?.institution).toBe("Ada Wallet");
    expect(statementRules().some((rule) => rule.id === "gtbank")).toBe(true);
  });
});
